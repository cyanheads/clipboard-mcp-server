/**
 * @fileoverview Windows clipboard backend using PowerShell and .NET System.Windows.Forms.Clipboard.
 * @module services/clipboard/windows-backend
 */

import { spawn } from 'node:child_process';
import { assertByteRange } from './byte-window.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import { buildInspectFormats, parseNativeTypeEntries, stripHtmlTags } from './types.js';

/** Run a PowerShell script. Returns stdout as Buffer. Optionally pipes stdin. */
function runPowershell(script: string, stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const child = spawn('powershell.exe', args, {
      shell: false,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (stdin) child.stdin?.end(stdin);
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
        reject(new Error('powershell.exe not found — requires PowerShell 5.1+ on Windows 10+'));
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

/** PowerShell script builder to read HTML from the clipboard, bounded to `range`. */
function buildPsReadHtml(range: ByteRange): string {
  assertByteRange(range);
  return `
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($data -and $data.GetDataPresent('HTML Format')) {
  $html = $data.GetData('HTML Format')
  if ($html -is [string]) {
    # Windows HTML clipboard format includes headers — extract just the HTML body
    $startIdx = $html.IndexOf('<html')
    if ($startIdx -eq -1) { $startIdx = $html.IndexOf('<HTML') }
    if ($startIdx -ge 0) { $html = $html.Substring($startIdx) }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($html)
    ${psSliceSnippet('$bytes', range)}
  } else { [PSCustomObject]@{ present = $false } | ConvertTo-Json -Compress }
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

/** Envelope every ranged PowerShell read script prints (see `psSliceSnippet`). */
interface RangedReadEnvelope {
  contentBase64?: string;
  height?: number;
  present: boolean;
  total?: number;
  width?: number;
}

/** Decode a ranged JSON/base64 PowerShell read response without altering its content. */
function decodeRangedRead(
  buf: Buffer,
  formatName: string,
): { contentBase64: string; height?: number; total: number; width?: number } {
  const raw = buf.toString('utf8').trim();
  const parsed = JSON.parse(raw) as RangedReadEnvelope | null;
  if (!parsed || typeof parsed.present !== 'boolean') {
    throw new Error(`Invalid PowerShell response while reading ${formatName}`);
  }
  if (!parsed.present) throw new Error(`${formatName} format not found on clipboard`);
  if (typeof parsed.total !== 'number' || typeof parsed.contentBase64 !== 'string') {
    throw new Error(`Invalid PowerShell response while reading ${formatName}`);
  }
  return {
    total: parsed.total,
    contentBase64: parsed.contentBase64,
    ...(parsed.width !== undefined && { width: parsed.width }),
    ...(parsed.height !== undefined && { height: parsed.height }),
  };
}

/**
 * Build a PowerShell script that writes text to the clipboard.
 * Content is passed via base64 to avoid any shell interpretation.
 */
function buildPsWriteText(contentBase64: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
$b64 = ${JSON.stringify(contentBase64)}
$bytes = [Convert]::FromBase64String($b64)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
[System.Windows.Forms.Clipboard]::SetText($text)
`;
}

/**
 * Build a PowerShell script that writes HTML + plain-text to the clipboard.
 * Content is passed via base64 to avoid any shell interpretation.
 */
function buildPsWriteHtml(htmlBase64: string, plaintextBase64: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
$hb64 = ${JSON.stringify(htmlBase64)}
$pb64 = ${JSON.stringify(plaintextBase64)}
$htmlBytes = [Convert]::FromBase64String($hb64)
$html = [System.Text.Encoding]::UTF8.GetString($htmlBytes)
$ptBytes = [Convert]::FromBase64String($pb64)
$pt = [System.Text.Encoding]::UTF8.GetString($ptBytes)
$data = New-Object System.Windows.Forms.DataObject
$data.SetData([System.Windows.Forms.DataFormats]::Html, $html)
$data.SetData([System.Windows.Forms.DataFormats]::Text, $pt)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
`;
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
      case 'html': {
        const buf = await runPowershell(buildPsReadHtml(range));
        const { total, contentBase64 } = decodeRangedRead(buf, 'HTML');
        return {
          format: 'html',
          content: Buffer.from(contentBase64, 'base64'),
          totalByteSize: total,
        };
      }
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
    if (format === 'text') {
      const b64 = buf.toString('base64');
      await runPowershell(buildPsWriteText(b64));
      return { format: 'text', byteSize: buf.byteLength };
    }
    const plaintext = stripHtmlTags(content);
    const htmlB64 = buf.toString('base64');
    const ptB64 = Buffer.from(plaintext, 'utf8').toString('base64');
    await runPowershell(buildPsWriteHtml(htmlB64, ptB64));
    return { format: 'html', byteSize: buf.byteLength };
  }

  async clear(): Promise<void> {
    await runPowershell(PS_CLEAR);
  }
}
