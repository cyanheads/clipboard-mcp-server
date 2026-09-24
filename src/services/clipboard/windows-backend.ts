/**
 * @fileoverview Windows clipboard backend using PowerShell and .NET System.Windows.Forms.Clipboard.
 * @module services/clipboard/windows-backend
 */

import { spawn } from 'node:child_process';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { assertByteRange } from './byte-window.js';
import { buildCfHtml, parseCfHtmlHeader } from './cf-html.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RangedReadWindow,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import {
  buildInspectFormats,
  clipboardOutcome,
  parseNativeTypeEntries,
  parseRangedReadEnvelope,
  stripHtmlTags,
} from './types.js';

/** Run a PowerShell script. Returns stdout as Buffer. Optionally pipes stdin. */
function runPowershell(script: string, stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const child = spawn('powershell.exe', args, {
      shell: false,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (stdin) {
      // A helper that exits before draining stdin surfaces as its exit code; the
      // resulting EPIPE on the pipe must not become an unhandled stream error.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdin);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`powershell exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`),
        );
      } else {
        resolve(Buffer.concat(out));
      }
    });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          clipboardOutcome(
            'Windows',
            'powershell.exe not found — requires PowerShell 5.1+ on Windows 10+',
            {
              category: 'clipboard_unavailable',
              recoveryHint:
                'Make PowerShell 5.1+ available as powershell.exe on PATH (built in on Windows 10 and later), then retry.',
            },
            err,
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Static PowerShell script for inspecting clipboard formats.
 * Returns JSON array of { type: string, bytes: number }.
 * Uses System.Windows.Forms.Clipboard.GetDataObject() to list explicit formats.
 */
const PS_INSPECT = `
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$result = @()
if ($data) {
  foreach ($fmt in $data.GetFormats($false)) {
    $bytes = 0
    try {
      $obj = $data.GetData($fmt)
      if ($obj -is [string]) { $bytes = [System.Text.Encoding]::UTF8.GetByteCount($obj) }
      elseif ($obj -is [byte[]]) { $bytes = $obj.Length }
      elseif ($obj -is [System.IO.MemoryStream]) { $bytes = $obj.Length }
    } catch {}
    $result += [PSCustomObject]@{ type = $fmt; bytes = $bytes }
  }
}
$result | ConvertTo-Json -Compress
`;

/**
 * Clamp-and-slice snippet shared by every ranged PowerShell read script,
 * given a `[byte[]]`-valued `$bytesVar` already holding the full
 * representation. Emits the `{ present, total, contentBase64 }` envelope
 * every ranged read returns; `extraFields` appends more hashtable entries
 * (e.g. `; width = $w; height = $h`) before the closing brace.
 */
function psSliceSnippet(bytesVar: string, range: ByteRange, extraFields = ''): string {
  return `
$total = ${bytesVar}.Length
$offset = ${range.offset}
$limit = ${range.limit}
$sliceLen = [Math]::Max(0, [Math]::Min($limit, $total - $offset))
if ($sliceLen -gt 0) {
  [byte[]]$slice = ${bytesVar}[$offset..($offset + $sliceLen - 1)]
} else {
  [byte[]]$slice = @()
}
[PSCustomObject]@{ present = $true; total = $total; contentBase64 = [Convert]::ToBase64String($slice)${extraFields} } | ConvertTo-Json -Compress
`;
}

/** PowerShell script builder to read plain text, bounded to `range`. */
function buildPsReadText(range: ByteRange): string {
  assertByteRange(range);
  return `
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$selectedFormat = $null
if ($data) {
  $nativeTextFormats = @(
    [System.Windows.Forms.DataFormats]::UnicodeText,
    [System.Windows.Forms.DataFormats]::Text,
    [System.Windows.Forms.DataFormats]::OemText
  )
  foreach ($format in $nativeTextFormats) {
    if ($data.GetDataPresent($format, $false)) {
      $selectedFormat = $format
      break
    }
  }
}
if ($selectedFormat) {
  $text = $data.GetData($selectedFormat, $false)
  if ($text -is [string]) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    ${psSliceSnippet('$bytes', range)}
  } else {
    [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress
  }
} else {
  [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress
}
`;
}

/**
 * PowerShell script builder that moves raw `HTML Format` bytes without
 * interpreting them: the representation's total size, the offset just past its
 * trailing NUL padding (`dataEnd`), a SHA-256 of every byte, its first
 * `prefixLimit` bytes, and the raw byte window `window`. CF_HTML framing is
 * parsed in TypeScript (`cf-html.ts`).
 */
function buildPsReadHtml(prefixLimit: number, window: ByteRange): string {
  assertByteRange(window);
  assertByteRange({ offset: 0, limit: prefixLimit });
  return `
Add-Type -AssemblyName System.Windows.Forms
$prefixLimit = ${prefixLimit}
$windowOffset = ${window.offset}
$windowLimit = ${window.limit}
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$raw = $null
if ($data -and $data.GetDataPresent('HTML Format')) { $raw = $data.GetData('HTML Format') }
if ($raw -is [System.IO.MemoryStream]) { $bytes = $raw.ToArray() }
elseif ($raw -is [string]) { $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw) }
else { $bytes = $null }
if ($null -ne $bytes) {
  $total = $bytes.Length
  $dataEnd = $total
  while ($dataEnd -gt 0 -and $bytes[$dataEnd - 1] -eq 0) { $dataEnd-- }
  $prefixLength = [Math]::Min($prefixLimit, $total)
  $windowStart = [Math]::Min($windowOffset, $total)
  $windowLength = [Math]::Min($windowLimit, $total - $windowStart)
  [PSCustomObject]@{
    present = $true
    total = $total
    dataEnd = $dataEnd
    sha256 = [Convert]::ToBase64String([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes))
    prefixBase64 = [Convert]::ToBase64String($bytes, 0, $prefixLength)
    contentBase64 = [Convert]::ToBase64String($bytes, $windowStart, $windowLength)
  } | ConvertTo-Json -Compress
} else { [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress }
`;
}

/** PowerShell script builder to read RTF from the clipboard, bounded to `range`. */
function buildPsReadRtf(range: ByteRange): string {
  assertByteRange(range);
  return `
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($data -and $data.GetDataPresent([System.Windows.Forms.DataFormats]::Rtf)) {
  $rtf = $data.GetData([System.Windows.Forms.DataFormats]::Rtf)
  if ($rtf -is [string]) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($rtf)
    ${psSliceSnippet('$bytes', range)}
  } else { [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress }
} else { [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress }
`;
}

/**
 * PowerShell script builder to read an image from the clipboard as
 * base64-encoded PNG, bounded to `range`. Width/height are captured from the
 * live `Image` object before it is disposed — always reported when an image
 * is present, regardless of `range`.
 */
function buildPsReadImage(range: ByteRange): string {
  assertByteRange(range);
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) {
  $w = $img.Width
  $h = $img.Height
  $ms = New-Object System.IO.MemoryStream
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $img.Dispose()
  ${psSliceSnippet('$bytes', range, '; width = $w; height = $h')}
} else { [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress }
`;
}

/**
 * Static PowerShell script that empties the clipboard.
 * `Clipboard::Clear()` removes every format; setting an empty string instead
 * would leave a zero-length text representation behind.
 */
const PS_CLEAR = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::Clear()
`;

/** Decode a ranged PowerShell read response (see `psSliceSnippet`) without altering its content. */
function decodeRangedRead(buf: Buffer, formatName: string): RangedReadWindow {
  return parseRangedReadEnvelope(buf.toString('utf8').trim(), 'Windows', formatName);
}

/**
 * Static PowerShell writer for every text and HTML write. The payload arrives
 * on stdin as a JSON envelope of base64 UTF-8 fields — `{ text, html? }`, where
 * `html` is a complete CF_HTML envelope — and is parsed as data, so no payload
 * byte ever reaches the command line or the script source. `HTML Format` is
 * stored as a MemoryStream, which WinForms copies to the clipboard verbatim;
 * the text goes out as UnicodeText. Any failed step exits non-zero.
 */
const PS_WRITE = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $envelope = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
  $data = New-Object System.Windows.Forms.DataObject
  if ($null -ne $envelope.html) {
    $data.SetData('HTML Format', [System.IO.MemoryStream]::new([Convert]::FromBase64String($envelope.html)))
  }
  $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($envelope.text))
  $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $text)
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

/**
 * Bytes of `HTML Format` fetched with the header call. Covers the CF_HTML
 * header and, for most clipboards, the whole payload — so the common read
 * takes one helper call; a window beyond it takes a second. Node holds at most
 * this prefix plus the requested window.
 */
const HTML_PREFIX_BYTES = 64 * 1024;

/** Decoded response of `buildPsReadHtml`. */
interface HtmlBytes {
  /** Offset just past the payload's trailing NUL padding. */
  dataEnd: number;
  prefix: Buffer;
  /** Base64 SHA-256 of the whole payload — identifies the clipboard contents across calls. */
  sha256: string;
  total: number;
  window: Buffer;
}

/** Run `buildPsReadHtml` and decode its response; an absent `HTML Format` is `format_unavailable`. */
async function runPsReadHtml(prefixLimit: number, window: ByteRange): Promise<HtmlBytes> {
  const raw = (await runPowershell(buildPsReadHtml(prefixLimit, window))).toString('utf8').trim();
  // The response carries clipboard bytes, so it never rides the error.
  const unreadable = () =>
    serializationError(
      'Windows clipboard helper returned an unreadable response while reading HTML.',
      {
        platform: 'Windows',
        format: 'HTML',
        responseBytes: raw.length,
      },
    );
  let parsed: {
    contentBase64?: unknown;
    dataEnd?: unknown;
    prefixBase64?: unknown;
    present?: unknown;
    sha256?: unknown;
    total?: unknown;
  } | null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unreadable();
  }
  if (!parsed || typeof parsed.present !== 'boolean') throw unreadable();
  if (!parsed.present) {
    throw clipboardOutcome('Windows', 'HTML format not found on clipboard', {
      category: 'format_unavailable',
    });
  }
  if (
    typeof parsed.total !== 'number' ||
    typeof parsed.dataEnd !== 'number' ||
    typeof parsed.sha256 !== 'string' ||
    typeof parsed.prefixBase64 !== 'string' ||
    typeof parsed.contentBase64 !== 'string'
  ) {
    throw unreadable();
  }
  return {
    total: parsed.total,
    dataEnd: parsed.dataEnd,
    sha256: parsed.sha256,
    prefix: Buffer.from(parsed.prefixBase64, 'base64'),
    window: Buffer.from(parsed.contentBase64, 'base64'),
  };
}

/**
 * Read `range` of the clipboard's HTML. For a CF_HTML payload, `range` and the
 * reported total apply to `[StartFragment, EndFragment)`; a payload without a
 * header is taken whole, minus trailing NUL padding.
 */
async function readHtml(range: ByteRange): Promise<ReadResult> {
  assertByteRange(range);
  const first = await runPsReadHtml(HTML_PREFIX_BYTES, { offset: 0, limit: 0 });
  const header = parseCfHtmlHeader(first.prefix, first.total);
  const spanStart = header ? header.startFragment : 0;
  const spanEnd = header ? header.endFragment : first.dataEnd;
  const spanSize = spanEnd - spanStart;

  const from = spanStart + Math.min(range.offset, spanSize);
  const to = spanStart + Math.min(range.offset + range.limit, spanSize);
  if (from === to || to <= first.prefix.byteLength) {
    return { format: 'html', content: first.prefix.subarray(from, to), totalByteSize: spanSize };
  }

  // The header already came with the first call; the hash ties the window to the same payload.
  const second = await runPsReadHtml(0, { offset: from, limit: to - from });
  if (second.sha256 !== first.sha256) {
    throw new Error('The clipboard changed while its HTML was being read. Retry the read.');
  }
  return { format: 'html', content: second.window, totalByteSize: spanSize };
}

/** Map Windows DataFormats string → semantic format. */
function winFormatToSemantic(fmt: string): ClipboardFormat | null {
  const lower = fmt.toLowerCase();
  if (lower === 'text' || lower === 'unicodetext' || lower === 'oemtext') return 'text';
  if (lower === 'html format') return 'html';
  if (lower === 'rich text format' || lower === 'rtf') return 'rtf';
  if (lower === 'bitmap' || lower === 'png' || lower === 'dib' || lower === 'dibv5') return 'image';
  return null;
}

/** Windows clipboard backend using PowerShell. */
export class WindowsBackend implements ClipboardBackend {
  async inspect(): Promise<InspectResult> {
    const buf = await runPowershell(PS_INSPECT);
    const raw = buf.toString('utf8').trim();

    // PowerShell writes nothing (or `null`) for an empty clipboard; every other
    // shape must parse as a type listing or the inspection has failed.
    const entries = raw === '' || raw === 'null' ? [] : parseNativeTypeEntries(raw, 'Windows');

    const rawTypes: RawTypeEntry[] = entries.map((e) => ({ type: e.type, bytes: e.bytes }));
    const semanticSet = new Set<ClipboardFormat>();
    for (const e of entries) {
      const fmt = winFormatToSemantic(e.type);
      if (fmt) semanticSet.add(fmt);
    }

    return { rawTypes, ...buildInspectFormats(semanticSet) };
  }

  async read(format: ClipboardFormat, range: ByteRange): Promise<ReadResult> {
    switch (format) {
      case 'text': {
        const buf = await runPowershell(buildPsReadText(range));
        const { total, contentBase64 } = decodeRangedRead(buf, 'Text');
        return {
          format: 'text',
          content: Buffer.from(contentBase64, 'base64'),
          totalByteSize: total,
        };
      }
      case 'html':
        return await readHtml(range);
      case 'rtf': {
        const buf = await runPowershell(buildPsReadRtf(range));
        const { total, contentBase64 } = decodeRangedRead(buf, 'RTF');
        return {
          format: 'rtf',
          content: Buffer.from(contentBase64, 'base64'),
          totalByteSize: total,
        };
      }
      case 'image': {
        const buf = await runPowershell(buildPsReadImage(range));
        const { total, contentBase64, width, height } = decodeRangedRead(buf, 'Image');
        return {
          format: 'image',
          content: Buffer.from(contentBase64, 'base64'),
          totalByteSize: total,
          ...(width !== undefined && { width }),
          ...(height !== undefined && { height }),
        };
      }
    }
  }

  async write(
    content: string,
    format: 'text' | 'html',
  ): Promise<{ format: 'text' | 'html'; byteSize: number }> {
    const buf = Buffer.from(content, 'utf8');
    const envelope =
      format === 'text'
        ? { text: buf.toString('base64') }
        : {
            text: Buffer.from(stripHtmlTags(content), 'utf8').toString('base64'),
            html: buildCfHtml(content).toString('base64'),
          };
    await runPowershell(PS_WRITE, Buffer.from(JSON.stringify(envelope), 'utf8'));
    return { format, byteSize: buf.byteLength };
  }

  async clear(): Promise<void> {
    await runPowershell(PS_CLEAR);
  }
}
