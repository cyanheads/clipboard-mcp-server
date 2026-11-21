/**
 * @fileoverview Windows clipboard backend using PowerShell and .NET System.Windows.Forms.Clipboard.
 * @module services/clipboard/windows-backend
 */

import { spawn } from 'node:child_process';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { assertByteRange } from './byte-window.js';
import { buildCfHtml, parseCfHtmlHeader } from './cf-html.js';
import { htmlToPlainText } from './html-to-text.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RangedReadWindow,
  ReadItems,
  ReadResult,
} from './types.js';
import {
  buildInspectResult,
  clipboardOutcome,
  parseNativeTypeEntries,
  parseRangedReadEnvelope,
  representationChanged,
  toReadResult,
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
 * PowerShell snippet that splits the file drop list in `$list` into `$kept`,
 * the paths the `files` format lists, and `$omitted`, the count of paths it
 * leaves out because they hold a line break (CR or LF) and so cannot be listed
 * one per line.
 */
const PS_LISTABLE_PATHS = `
$kept = [System.Collections.Generic.List[string]]::new()
$omitted = 0
foreach ($path in $list) {
  if ($path.IndexOfAny([char[]]@(10, 13)) -ge 0) { $omitted++ } else { $kept.Add($path) }
}`;

/** PowerShell expression for the LF-joined `$kept` paths. */
const PS_JOINED_PATHS = '[string]::Join([string][char]10, $kept.ToArray())';

/**
 * Static PowerShell script listing the clipboard's native formats
 * (`GetDataObject().GetFormats($false)`), printed as JSON `RawTypeEntry`
 * values. A string is sized as UTF-8, a byte array or stream by its length,
 * and a FileDrop list as the UTF-8 of the paths a `files` read returns; a
 * FileDrop list with no path to return, a `GetData` that returns null or
 * throws, and non-string data under a text or RTF format (which the text and
 * RTF reads cannot return) are failed measurements; any other object (a
 * `Bitmap`) is listed without a size.
 */
const PS_INSPECT = `
Add-Type -AssemblyName System.Windows.Forms
$stringOnly = @([System.Windows.Forms.DataFormats]::UnicodeText, [System.Windows.Forms.DataFormats]::Text, [System.Windows.Forms.DataFormats]::OemText, [System.Windows.Forms.DataFormats]::Rtf)
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$result = @()
if ($data) {
  foreach ($fmt in $data.GetFormats($false)) {
    $entry = [ordered]@{ type = $fmt }
    try {
      $obj = $data.GetData($fmt)
      if ($null -eq $obj) { $entry.measurementFailed = $true }
      elseif ($obj -is [string]) { $entry.bytes = [System.Text.Encoding]::UTF8.GetByteCount($obj) }
      elseif ($stringOnly -contains $fmt) { $entry.measurementFailed = $true }
      elseif ($fmt -eq [System.Windows.Forms.DataFormats]::FileDrop -and $obj -is [string[]]) {
        $list = $obj${PS_LISTABLE_PATHS}
        if ($kept.Count -gt 0) { $entry.bytes = [System.Text.Encoding]::UTF8.GetByteCount(${PS_JOINED_PATHS}) }
        else { $entry.measurementFailed = $true }
      }
      elseif ($obj -is [byte[]]) { $entry.bytes = $obj.Length }
      elseif ($obj -is [System.IO.Stream]) { $entry.bytes = $obj.Length }
    } catch { $entry.measurementFailed = $true }
    $result += [PSCustomObject]$entry
  }
}
$result | ConvertTo-Json -Compress
`;

/** PowerShell expression for the base64 SHA-256 of every byte in `bytesVar`. */
function psSha256(bytesVar: string): string {
  return `[Convert]::ToBase64String([System.Security.Cryptography.SHA256]::Create().ComputeHash(${bytesVar}))`;
}

/**
 * Clamp-and-slice snippet shared by every ranged PowerShell read script,
 * given a `[byte[]]`-valued `$bytesVar` already holding the full
 * representation. Emits the `{ present, total, contentBase64, revision }`
 * envelope every ranged read returns — `contentBase64` is encoded straight
 * from the full array with the offset/length overload (the start clamped to
 * `$total`, so a window past the end is empty), and `revision` is the SHA-256
 * of the full representation the helper already holds; `extraFields` appends
 * more hashtable entries (e.g. `; width = $w; height = $h`) before the closing brace.
 * The clamps run in 64-bit: an offset past Int32 would otherwise make
 * PowerShell pick `[Math]::Min(Int32, Int32)` and fail converting it.
 */
function psSliceSnippet(bytesVar: string, range: ByteRange, extraFields = ''): string {
  return `
$total = ${bytesVar}.Length
$offset = ${range.offset}
$limit = ${range.limit}
$start = [Math]::Min([long]$offset, [long]$total)
$sliceLen = [Math]::Min([long]$limit, [long]$total - $start)
[PSCustomObject]@{ present = $true; total = $total; contentBase64 = [Convert]::ToBase64String(${bytesVar}, $start, $sliceLen); revision = ${psSha256(bytesVar)}${extraFields} } | ConvertTo-Json -Compress
`;
}

/**
 * PowerShell script builder to read plain text, bounded to `range`: the first
 * native text format whose data is a string. A listed format whose `GetData`
 * yields no string is skipped, matching the inspection, which does not count it.
 */
function buildPsReadText(range: ByteRange): string {
  assertByteRange(range);
  return `
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$text = $null
if ($data) {
  $nativeTextFormats = @(
    [System.Windows.Forms.DataFormats]::UnicodeText,
    [System.Windows.Forms.DataFormats]::Text,
    [System.Windows.Forms.DataFormats]::OemText
  )
  foreach ($format in $nativeTextFormats) {
    if ($data.GetDataPresent($format, $false)) {
      $candidate = $data.GetData($format, $false)
      if ($candidate -is [string]) {
        $text = $candidate
        break
      }
    }
  }
}
if ($null -ne $text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  ${psSliceSnippet('$bytes', range)}
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
    sha256 = ${psSha256('$bytes')}
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
 * PowerShell script builder to read an image from the clipboard as PNG,
 * bounded to `range`. A registered `PNG` format that `System.Drawing` decodes
 * is returned as-is, with the decoded width/height. Otherwise `GetImage()` —
 * which answers only from `Bitmap` data, never from `PNG` — is re-encoded as
 * PNG, with width/height captured from the live `Image` before it is disposed.
 * A zero-length `PNG` with no bitmap is a present, empty image; an undecodable
 * one with no bitmap is absent.
 */
function buildPsReadImage(range: ByteRange): string {
  assertByteRange(range);
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$png = $null
if ($data -and $data.GetDataPresent('PNG', $false)) {
  $raw = $data.GetData('PNG', $false)
  if ($raw -is [System.IO.MemoryStream]) { $png = $raw.ToArray() }
  elseif ($raw -is [byte[]]) { $png = $raw }
}
$pngDecodes = $false
if ($null -ne $png -and $png.Length -gt 0) {
  try {
    $probe = [System.Drawing.Image]::FromStream([System.IO.MemoryStream]::new($png))
    $w = $probe.Width
    $h = $probe.Height
    $probe.Dispose()
    $pngDecodes = $true
  } catch {}
}
if ($pngDecodes) {
  ${psSliceSnippet('$png', range, '; width = $w; height = $h')}
} else {
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
  } elseif ($null -ne $png -and $png.Length -eq 0) {
    ${psSliceSnippet('$png', range)}
  } else { [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress }
}
`;
}

/**
 * PowerShell script builder to read the copied files' paths, bounded to
 * `range`: the file drop list (`GetFileDropList()`, in list order) minus the
 * paths holding a line break, LF-joined and encoded as UTF-8. The envelope
 * counts the left-out paths as `omittedPaths`; a list with no path to return
 * is absent.
 */
function buildPsReadFiles(range: ByteRange): string {
  assertByteRange(range);
  return `
Add-Type -AssemblyName System.Windows.Forms
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()${PS_LISTABLE_PATHS}
if ($kept.Count -gt 0) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(${PS_JOINED_PATHS})
  ${psSliceSnippet('$bytes', range, '; omittedPaths = $omitted')}
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

/** Run a ranged PowerShell read script and decode the envelope it prints (see `psSliceSnippet`). */
async function runPsRangedRead(script: string, formatName: string): Promise<RangedReadWindow> {
  const buf = await runPowershell(script);
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

/** A Windows clipboard holds one data object: every successful read is of item 0 of 1. */
const ONE_ITEM: ReadItems = { itemCount: 1 };

/**
 * Read `range` of the clipboard's HTML. For a CF_HTML payload, `range` and the
 * reported total apply to `[StartFragment, EndFragment)`; a payload without a
 * header is taken whole, minus trailing NUL padding. The whole payload's hash
 * is the read's revision.
 */
async function readHtml(range: ByteRange): Promise<ReadResult> {
  assertByteRange(range);
  const first = await runPsReadHtml(HTML_PREFIX_BYTES, { offset: 0, limit: 0 });
  const header = parseCfHtmlHeader(first.prefix, first.total);
  const spanStart = header ? header.startFragment : 0;
  const spanEnd = header ? header.endFragment : first.dataEnd;
  const spanSize = spanEnd - spanStart;
  const read = (content: Buffer): ReadResult => ({
    format: 'html',
    content,
    totalByteSize: spanSize,
    revision: first.sha256,
    ...ONE_ITEM,
  });

  const from = spanStart + Math.min(range.offset, spanSize);
  const to = spanStart + Math.min(range.offset + range.limit, spanSize);
  if (from === to || to <= first.prefix.byteLength) return read(first.prefix.subarray(from, to));

  // The header already came with the first call; the hash ties the window to the same payload.
  const second = await runPsReadHtml(0, { offset: from, limit: to - from });
  if (second.sha256 !== first.sha256) throw representationChanged('Windows', 'HTML');
  return read(second.window);
}

/**
 * Map a .NET clipboard format name → semantic format. CF_DIB surfaces as
 * `DeviceIndependentBitmap`, and CF_DIBV5, which has no .NET name, as
 * `Format17`; Windows synthesizes the `Bitmap` that `GetImage()` reads from
 * either. CF_HDROP surfaces as `FileDrop`.
 */
function winFormatToSemantic(fmt: string): ClipboardFormat | null {
  const lower = fmt.toLowerCase();
  if (lower === 'text' || lower === 'unicodetext' || lower === 'oemtext') return 'text';
  if (lower === 'html format') return 'html';
  if (lower === 'rich text format' || lower === 'rtf') return 'rtf';
  if (
    lower === 'bitmap' ||
    lower === 'png' ||
    lower === 'deviceindependentbitmap' ||
    lower === 'format17'
  ) {
    return 'image';
  }
  if (lower === 'filedrop') return 'files';
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
    return buildInspectResult(entries, winFormatToSemantic, entries.length > 0 ? 1 : 0);
  }

  /**
   * The clipboard is one data object: `item` 0 reads it, and any later `item`
   * is `format_unavailable` without running a helper.
   */
  async read(format: ClipboardFormat, range: ByteRange, item?: number): Promise<ReadResult> {
    if (item !== undefined && item > 0) {
      throw clipboardOutcome(
        'Windows',
        `The clipboard holds one item (item 0); item ${item} is not on it.`,
        { category: 'format_unavailable' },
      );
    }
    const readRanged = async (build: (range: ByteRange) => string, formatName: string) =>
      toReadResult(format, await runPsRangedRead(build(range), formatName), ONE_ITEM);
    switch (format) {
      case 'text':
        return await readRanged(buildPsReadText, 'Text');
      case 'html':
        return await readHtml(range);
      case 'rtf':
        return await readRanged(buildPsReadRtf, 'RTF');
      case 'image':
        return await readRanged(buildPsReadImage, 'Image');
      case 'files':
        return await readRanged(buildPsReadFiles, 'FileDrop');
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
            text: Buffer.from(htmlToPlainText(content), 'utf8').toString('base64'),
            html: buildCfHtml(content).toString('base64'),
          };
    await runPowershell(PS_WRITE, Buffer.from(JSON.stringify(envelope), 'utf8'));
    return { format, byteSize: buf.byteLength };
  }

  async clear(): Promise<void> {
    await runPowershell(PS_CLEAR);
  }
}
