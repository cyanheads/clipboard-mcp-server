# clipboard-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `clipboard_read` | Read the current clipboard contents in a requested format. For `auto`, returns the richest explicitly-set format available (image > html > rtf > text). Images are returned as base64-encoded PNG with dimensions. Oversized content is read in `offset`/`limit` slices tied together by `representationId`. | `format: "text" \| "html" \| "rtf" \| "image" \| "auto"`, `offset`, `limit`, `representationId` | `readOnlyHint: true`, `openWorldHint: false` |
| `clipboard_write` | Write content to the clipboard. `text` sets plain text. `html` publishes HTML on every platform; macOS and Windows also publish a stripped plain-text fallback, while on Linux the markup is the only payload and plain-text requests can receive it too. | `content: string`, `format: "text" \| "html"` | `destructiveHint: true` (replaces current contents) |
| `clipboard_inspect` | List the types the clipboard offers with their measured byte sizes and a semantic summary of the formats `clipboard_read` can return. Useful for deciding which format to request before calling `clipboard_read`. No content returned. | _(none)_ | `readOnlyHint: true`, `openWorldHint: false` |

### Resources

None. All clipboard access is ephemeral; stable URIs don't apply here.

### Prompts

None. Pure data/action server.

---

## Overview

`clipboard-mcp-server` gives agents structured access to the system clipboard across macOS, Linux, and Windows. Agents can read the current contents (plain text, HTML, RTF, or image), write new content, and inspect available formats without fetching full content. No history, no monitoring — just the current clipboard state.

The primary use case: agents that need to receive content a user has copied (a URL, a code snippet, an error message, HTML from a browser selection) without requiring the user to paste it into the conversation. Write support lets agents stage output for the user to paste elsewhere.

**Platform backends:**
- **macOS**: JXA/NSPasteboard (via `osascript`) for inspection, every read, and every write
- **Linux**: `xclip` (X11) or `wl-clipboard` (Wayland) — detected at startup
- **Windows**: .NET `System.Windows.Forms.Clipboard` via PowerShell for text and rich types; the CF_HTML (`HTML Format`) framing is built and parsed in TypeScript

The tool surface is platform-agnostic — same tools, same schemas, same behavior. Platform differences are encapsulated in the service layer. Feature availability varies by platform (see Platform Capabilities below).

---

## Requirements

- Read current clipboard: plain text, HTML, RTF, image (base64 PNG)
- Write current clipboard: plain text or HTML; HTML includes a stripped plain-text fallback on macOS and Windows
- Inspect clipboard types and byte sizes without fetching full content
- Cross-platform: macOS, Linux (X11 + Wayland), Windows
- Platform detection at startup — select appropriate backend, error if clipboard tools not available
- No clipboard history, no polling/watching, no file references
- Local deployment only — stdio by default; the framework's Streamable HTTP transport (`MCP_TRANSPORT_TYPE=http`) binds `127.0.0.1` by default, since the clipboard served is the host's own
- No auth required (local user's own clipboard)

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ClipboardService` | Platform-specific clipboard backends (see below) | All three tools |

The service uses a **backend adapter pattern** — a common interface (`ClipboardBackend`) with platform-specific implementations:

| Backend | Platform | Text | HTML | RTF | Image | Inspect |
|:--------|:---------|:-----|:-----|:----|:------|:--------|
| `MacosBackend` | darwin | JXA `dataForType` read; JXA `setStringForType` write | JXA `dataForType` | JXA NSPasteboard | JXA NSPasteboard (TIFF→PNG) | JXA `pb.types` |
| `LinuxX11Backend` | linux (X11) | `xclip -selection clipboard` | `xclip -t text/html` | `xclip -t text/rtf` | `xclip -t image/png` | `xclip -o -t TARGETS` |
| `LinuxWaylandBackend` | linux (Wayland) | `wl-paste --no-newline` / `wl-copy` | `wl-paste --no-newline -t text/html` | `wl-paste --no-newline -t text/rtf` | `wl-paste --no-newline -t image/png` | `wl-paste --list-types` |
| `WindowsBackend` | win32 | PowerShell .NET Forms.Clipboard (`UnicodeText`) | PowerShell moves raw `HTML Format` bytes; `cf-html.ts` builds and parses the CF_HTML envelope | PowerShell .NET | PowerShell: registered `PNG` bytes that decode, else `GetImage()` bitmap→PNG | PowerShell `GetDataObject().GetFormats()` |

Both Linux backends decide whether a format is present from the type listing (`TARGETS` / `--list-types`) before reading it, never from a conversion succeeding: an `xclip`-owned selection — the state this server's own X11 writes leave — answers any requested target with its one buffer. `wl-paste` appends `\n` to every type it treats as text unless given `--no-newline`, so every payload read and size measurement passes it.

**`clipboard_inspect` and `clipboard_read` agree.** Every backend reports each listed type in one of three shapes, and `buildInspectResult()` in `types.ts` derives the formats from them:

| Entry | Meaning | Makes its format available |
|:---|:---|:---|
| `{ type, bytes }` | Measured. `bytes: 0` is present and empty, and reads as empty content — an image included | Yes |
| `{ type }` | Listed but not sized: a Linux target with no semantic format (`TARGETS`, `TIMESTAMP`, custom MIME types — never converted, since `DELETE` and `MULTIPLE` have side effects), or a Windows object that is not a string, byte array, or stream (a `Bitmap`) | Yes, when it maps to a format |
| `{ type, measurementFailed: true }` | Listed, but its data was nil (macOS: a declared type never set), null or threw (Windows `GetData`), was not a string under a Windows text or RTF format (those reads take only strings), or failed to read (Linux) | No — `clipboard_read` cannot return it |

An image read takes the first image representation that yields PNG bytes, skipping zero-length and undecodable ones, and returns the empty image success only when every listed one is zero-length. On Windows a registered `PNG` format that `System.Drawing` decodes is returned as-is, with the decoded dimensions, before `GetImage()` is tried, since `GetImage()` answers only from `Bitmap` data (which Windows synthesizes from `DeviceIndependentBitmap` / `Format17`, never from `PNG`).

**Classified helper outcomes.** Each backend maps its helper's result onto one of four categories, thrown as a typed sentinel (`clipboardOutcome()` / `isClipboardOutcome()` in `types.ts`); the tools branch on the category and never read message text. Unrecognized helper failures stay ordinary errors.

| Category | Tool reason | Linux X11 (`xclip` 0.13 / git builds) | Linux Wayland (`wl-clipboard` ≤ 2.1 / ≥ 2.2) | macOS / Windows |
|:---|:---|:---|:---|:---|
| `empty` | `format_unavailable` | `Error: target TARGETS not available` / `There is no owner for the CLIPBOARD selection` | `No selection` / `Nothing is copied` | — |
| `format_unavailable` | `format_unavailable` | type absent from `TARGETS`; a race after listing: `Error: target <T> not available` / `cannot convert CLIPBOARD selection to target '<T>'` | type absent from `--list-types`; after listing: `No suitable type of content copied` / `Clipboard content is not available as requested type …` | helper reports the representation absent |
| `representation_changed` | `representation_changed` | — | — | macOS: the two `changeCount` samples differ; Windows: the two `HTML Format` calls hash differently |
| `clipboard_unavailable` | `clipboard_unavailable` | `xclip`/`xsel` `ENOENT`; `Can't open display` | `wl-paste`/`wl-copy` `ENOENT`; `Failed to connect to a Wayland server` | Windows `powershell.exe` `ENOENT` |

A `clipboard_unavailable` sentinel carries a backend-specific recovery hint — the install command, or the session variable (`DISPLAY`, `WAYLAND_DISPLAY`) to fix — which the tools put on the wire as `data.recovery.hint`.

A macOS or Windows read helper whose output is neither a well-formed `{ present, total, contentBase64, revision }` envelope nor the `{ changed: true }` a macOS script prints for a mid-read change fails as a SerializationError (-32070) from `parseRangedReadEnvelope()` — never a `ValidationError`, which would blame the caller's input, and never `format_unavailable`. The error carries no helper output, since that output can hold clipboard bytes.

**Backend selection at startup:**
1. Check `process.platform`
2. For Linux: check `$WAYLAND_DISPLAY` (Wayland) vs `$DISPLAY` (X11)
3. Verify the required CLI tool with the platform-native PATH probe (`which` on Linux, `where.exe` on Windows)
4. If tool not found → startup error with install guidance

The service is thin: no retries (clipboard ops are local and near-instant), no HTTP resilience. Its job is to encapsulate platform detection, subprocess spawning, and format conversion.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| _(none)_ | — | No API keys or external config needed. Platform detected at startup via `process.platform`. |

---

## Implementation Order

1. `ClipboardService` — platform guard; reads, writes, and inspection via JXA subprocess
2. `clipboard_inspect` — safest, read-only, good smoke test for service layer
3. `clipboard_read` — adds format routing and image path; depends on service
4. `clipboard_write` — adds write path; most risk (destructive)

Each step is independently testable.

---

## Design Decisions

### Three tools, not one

`inspect` + `read` + `write` rather than a unified `clipboard` tool with a `mode` enum. The operations have fundamentally different risk profiles (`readOnlyHint` vs `destructiveHint`), different output shapes (metadata vs content vs void), and different call frequency. Splitting them lets MCP clients apply the right permissions and approval flows automatically.

### `auto` format priority: image > html > rtf > text

An agent that wants "what did I copy?" should get the richest explicitly-set type. Images and HTML carry information that plain text silently loses. The priority is based on information density, not frequency — text is the most common, but `auto` returning text when the user just copied a rich table from a browser would be a silent downgrade.

`auto` reads the listed formats in that order and moves on only when a read reports its format absent (`format_unavailable`) — the case of an image listed with bytes no decoder accepts. Any other failure (`representation_changed`, `clipboard_unavailable`, `content_too_large`) ends the call, and a `representationId` continuation is compared against the format actually read.

**Critical distinction**: use `pb.types` rather than `availableTypeFromArray` for format detection. `availableTypeFromArray` claims types the pasteboard cannot actually supply (a text clipboard returns `true` for a PNG availability check), and `pb.stringForType($.NSPasteboardTypeHTML)` returns null for plain-text clipboards despite it claiming HTML is available. `pb.types` lists the types the owner declared plus the translations AppKit can supply — `public.tiff` beside a `public.png`, `public.utf8-plain-text` beside `public.utf16-plain-text` or `public.rtf` — and a declared type can have nil data (`pbcopy` of RTF-header input leaves `public.utf8-plain-text` declared and unset). Inspection therefore reads `dataForType` for every listed type and reports nil as `measurementFailed`, which does not make the format available.

### Image output: always PNG

macOS copies images as TIFF internally. The tool always returns PNG (converting TIFF via `NSBitmapImageRep.imageRepWithData` + `representationUsingTypeProperties(NSBitmapImageFileTypePNG, {})`). Verified working. PNG is the only practical base64-over-JSON image format — TIFF is a container format most downstream consumers don't handle.

### HTML write: platform-dependent representations

On macOS and Windows, HTML writes publish both HTML and an auto-generated, tag-stripped plain-text fallback. This matches browser clipboard behavior and gives plain-text-only paste targets a usable representation.

On Linux the command-line helpers carry exactly one payload per owner, so there is no stripped fallback and a plain-text paste can receive the raw markup:

- **Wayland:** `wl-copy -t text/html` offers the same bytes under `text/html` plus `text/plain`, `text/plain;charset=utf-8`, `TEXT`, `STRING`, and `UTF8_STRING` (upstream `wl-copy` adds those aliases to every textual type). `clipboard_inspect` then lists both `html` and `text`, and a `text` read returns the markup.
- **X11:** `xclip -t text/html` advertises only `TARGETS` and `text/html`, so `clipboard_inspect` lists `html` alone and a `text` read fails `format_unavailable` — but `xclip` answers a request for any other target (`UTF8_STRING`, `STRING`, …) with the same markup, labelled `text/html`. A plain-text requester that accepts that reply gets the markup (`xclip -o -t UTF8_STRING` does); one that checks the reply type gets nothing (`xsel -o` returns an empty string).

Publishing a stripped fallback on Linux would need a helper that can own several representations at once.

### macOS: JXA reads raw bytes, one stdin-fed JXA script writes

JXA via `osascript -l JavaScript` handles inspection, every read, clear, and every write. Text and HTML are ranged `dataForType` reads, like RTF: HTML from `public.html`, text from the first non-nil of `public.utf8-plain-text` and `public.plain-text` (AppKit translates UTF-16 plain text into the former, not the latter). Nil data is `format_unavailable`, so a text read needs no inspection first.

Reads never decode through NSString. `stringForType` — and `pbpaste`, which decodes the same way — consumes a leading byte-order mark, so the bytes returned would disagree with the size `clipboard_inspect` measured; `pbpaste` also falls back to EPS or RTF when no plain text is present. Raw bytes keep the BOM, and a non-UTF-8 payload comes back as-is, as it does on Linux.

Writes do not use `pbcopy`: it re-types input that begins with an RTF (`{\rtf`) or EPS (`%!PS-Adobe-2.0 EPSF-2.0`) header as that type, so a literal text write could leave no text representation, and it has no flag to turn that off. The JXA writer publishes text with `setStringForType` as `public.utf8-plain-text` whatever its leading bytes.

### Writes: fixed script, constant argv, payload on stdin (macOS and Windows)

Every macOS and Windows write runs one static script — `JXA_WRITE` / `PS_WRITE` — with the same argv for every payload. The payload goes on stdin as a JSON envelope of base64 UTF-8 fields, `{ "text": …, "html"?: … }`, which the script parses as data (JXA `NSFileHandle.fileHandleWithStandardInput`, PowerShell `[Console]::OpenStandardInput()` + `ConvertFrom-Json`). Each script checks every pasteboard/clipboard set and exits non-zero on failure, which the backend reports as an error.

Why: embedding the payload in the command line capped writes far below the 1 MiB contract — macOS `ARG_MAX` (1 MiB, shared with the environment) failed HTML writes above ~390 KB with `E2BIG`, and Windows' 32,767-character command line would fail text above ~24 KB and HTML above ~12 KB. Stdin has no such limit, and payload bytes never reach script source, so there is nothing to escape. Rejected: a temp file (lifecycle and permissions for no gain over stdin) and PowerShell `-EncodedCommand` (still argv).

### Windows HTML: CF_HTML is TypeScript's job; PowerShell only moves bytes

Windows stores HTML as CF_HTML (`HTML Format`): a UTF-8 header of `Name:Value` lines whose `StartHTML`/`EndHTML`/`StartFragment`/`EndFragment` values are byte offsets into the data. `src/services/clipboard/cf-html.ts` builds and parses it.

- **Write.** `buildCfHtml()` wraps the HTML in `Version:0.9` plus fixed-width zero-padded offsets and a minimal `<html><body>` context. `PS_WRITE` stores the envelope as a `MemoryStream`, which WinForms copies verbatim (a string `SetData(DataFormats.Html, …)` stores raw UTF-8 with no header). The tag-stripped fallback goes out as `UnicodeText`; `DataFormats.Text` would encode it in the ANSI code page and drop characters such as `😀`.
- **Read.** The read script returns the representation's total size, the offset past its trailing NUL padding, a SHA-256 of every byte, a 64 KiB prefix, and the raw byte window TypeScript asks for — no CF_HTML parsing. `parseCfHtmlHeader()` validates the header (CRLF/LF/CR line endings, zero-padded offsets, `StartHTML:-1`/`EndHTML:-1`, optional selection offsets) and resolves `[StartFragment, EndFragment)`; `totalByteSize`, `offset`, and `limit` apply to that fragment. A window inside the prefix takes one helper call; a window beyond it takes a second, and the read fails with `representation_changed` if the two calls report different hashes — the clipboard changed in between. The hash is also the read's revision (see [Chunked reads](#chunked-reads-representationid)). Node holds at most prefix plus window. A malformed header fails with a SerializationError naming the field; header text is never returned as HTML. A payload with no `Version:` header is returned whole, minus trailing NULs.
- **Why the fragment.** It is what macOS (`public.html`) and Linux (`text/html`) expose, and it round-trips `clipboard_write` exactly. Context-only material (e.g. a `<head><style>` block a producer places before the fragment) is not returned.

### Chunked reads: `representationId`

Every successful `clipboard_read` returns `representationId` = `<format>:<revision>`, where each backend derives the revision in the same pass that produces the slice:

| Read path | Revision |
|:--|:--|
| `xclip` (X11), `wl-paste` (Wayland) | base64url SHA-256 of the full representation, hashed in Node over the stream the window is cut from (`collectHashedByteWindow`) |
| PowerShell (Windows) | base64 SHA-256 computed in the helper over the bytes it already holds; `HTML Format` uses the hash its read already returns |
| JXA (macOS) | `NSPasteboard.changeCount`, sampled before the data access and again after it in the same run |

A caller passes the previous slice's token back as `representationId`; a different current token fails the call with `representation_changed` (`Conflict`) before any bytes or image block leave the handler. A change caught inside one read — the two `changeCount` samples differ, or the two Windows `HTML Format` calls hash differently — fails with the same reason. A clipboard emptied, or no longer holding the format, between slices still fails `format_unavailable`, since presence is checked before identity.

- **Why the format is in the token.** An `auto` continuation that resolves to a different format must conflict even when the bytes are identical.
- **Why hash or `changeCount`, not re-inspection or a platform sequence number.** Re-inspecting sizes misses same-size replacements and adds a race. Windows `GetClipboardSequenceNumber` returns 0 without clipboard access and lags delayed rendering, an `xclip`-owned X11 selection answers `TIMESTAMP` with its payload, and Wayland exposes no generation value. Every hashing path already streams or holds the whole representation on every slice, so hashing adds CPU proportional to the size and no helper call or I/O.
- **Known false positive.** On macOS a producer that re-publishes identical content still bumps `changeCount`, so the continuation conflicts; restarting at offset 0 recovers.

### Image slices are byte chunks

An image read attaches an `image/png` block to `content[]` only when the response holds the whole, non-empty representation (`byteSize === totalByteSize > 0`). A partial slice — first, middle, or final — is a PNG byte chunk that no decoder should see as a picture, so it attaches no block: `format()` renders its byte range, its base64 in a fenced block, and the instruction to base64-decode each chunk separately and concatenate the bytes in offset order. `structuredContent.content` is the same base64 either way.

## Tool Contracts

### `clipboard_read`

```ts
input: z.object({
  format: z.enum(['text', 'html', 'rtf', 'image', 'auto'])
    .default('auto')
    .describe(
      'Format to return. "auto" returns the richest format explicitly present on the clipboard ' +
      '(priority: image > html > rtf > text), moving on to the next one when a listed format cannot be read. ' +
      '"image" returns base64-encoded PNG with dimensions. ' +
      '"html" returns raw HTML source as copied from a browser. "rtf" returns raw RTF markup. ' +
      '"text" returns plain text. If the requested format is not on the clipboard, ' +
      'the tool returns an error — use "auto" when unsure, or call clipboard_inspect first.'
    ),
  offset: z.number().int().min(0).optional()
    .describe('Byte offset to start the slice at; pass the previous nextOffset to continue.'),
  limit: z.number().int().min(4).optional()
    .describe('Maximum bytes in this slice, clamped to the format size limit; offset alone reads up to that limit.'),
  representationId: z.string().optional()
    .describe("The previous slice's representationId; a different current value fails with representation_changed."),
})

output: z.object({
  format: z.enum(['text', 'html', 'rtf', 'image'])
    .describe('The format actually returned (relevant when input was "auto").'),
  content: z.string()
    .describe('Clipboard contents. For "image", base64-encoded PNG data; a partial image slice is a PNG byte chunk, not a standalone image.'),
  width: z.number().int().optional()
    .describe('Image width in pixels, when the dimensions could be determined.'),
  height: z.number().int().optional()
    .describe('Image height in pixels, when the dimensions could be determined.'),
  byteSize: z.number().int()
    .describe('Size of the content returned in this response, in bytes.'),
  totalByteSize: z.number().int()
    .describe('Total byte size of the full representation.'),
  complete: z.boolean()
    .describe('True when this response reaches the end of the representation.'),
  nextOffset: z.number().int().optional()
    .describe('Offset to continue from. Absent once complete is true.'),
  representationId: z.string()
    .describe('Opaque token for the value and format this response was cut from; equal across full and sliced reads of an unchanged value.'),
})

errors: [
  {
    reason: 'format_unavailable',
    code: JsonRpcErrorCode.NotFound,
    when: 'Requested format is not present on the clipboard, or the clipboard is empty',
    recovery: 'Call clipboard_inspect to see available formats, then retry with a supported format or use "auto".',
  },
  {
    reason: 'content_too_large',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Clipboard content exceeds size limit (512KB text/HTML/RTF, 5MB image) and no offset/limit was given',
    data: { bytes: number, limit: number, format: string },
    recovery: 'Retry with offset: 0 and a limit at or under the format size limit, then follow nextOffset until complete is true — or request a smaller format. Image slices are PNG byte chunks, not standalone images: base64-decode each one and concatenate the bytes in offset order.',
  },
  {
    reason: 'representation_changed',
    code: JsonRpcErrorCode.Conflict,
    when: 'representationId was passed and the value being read now has a different one, or the clipboard changed during this read',
    data: { requestedFormat?: string, platform?: string },
    recovery: 'The clipboard changed during the read — after an earlier slice, or while this call was reading. Discard the bytes read so far and restart at offset 0 without representationId.',
  },
  {
    reason: 'clipboard_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The platform clipboard helper is missing from PATH, or it cannot reach the desktop session (no display or compositor)',
    data: { platform: string },  // data.recovery.hint is the backend's specific install command or session variable
    recovery: 'Install the clipboard helper (Linux X11: apt install xclip; Wayland: apt install wl-clipboard; Windows: PowerShell 5.1+), or run the server inside the desktop session so DISPLAY or WAYLAND_DISPLAY names a live display, then retry.',
  },
  {
    reason: 'inspect_unreadable',
    code: JsonRpcErrorCode.SerializationError,
    when: 'Format "auto" inspects the clipboard first, and the platform clipboard helper returned a type listing this server could not read',
    data: { platform: string },  // never the helper output
    recovery: 'Retry clipboard_read with an explicit format (text, html, rtf, or image), which reads without that inspection; if it fails too, copy the content afresh.',
  },
]

annotations: { readOnlyHint: true, openWorldHint: false }
```

### `clipboard_write`

```ts
input: z.object({
  content: z.string()
    .describe('Content to write to the clipboard.'),
  format: z.enum(['text', 'html'])
    .default('text')
    .describe(
      'Format of the content. "text" writes plain text. ' +
      '"html" writes HTML; on macOS and Windows it also publishes an auto-generated, ' +
      'tag-stripped plain-text fallback. On Linux there is no stripped fallback: Wayland also ' +
      'offers the markup under the plain-text types, and X11 hands the same markup to a plain-text request.'
    ),
})

output: z.object({
  format: z.enum(['text', 'html'])
    .describe('Format written.'),
  byteSize: z.number().int()
    .describe('Byte size of the written content.'),
})

errors: [
  {
    reason: 'content_too_large',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Write content exceeds the 1MB size limit',
    data: { bytes: number, limit: number },
    recovery: 'Content is too large to write to the clipboard. Truncate or summarize before writing.',
  },
  {
    reason: 'clipboard_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The platform clipboard helper is missing from PATH, or it cannot reach the desktop session (no display or compositor)',
    recovery: 'Install the clipboard helper (Linux X11: apt install xclip, plus xsel for clear; Wayland: apt install wl-clipboard; Windows: PowerShell 5.1+), or run the server inside the desktop session so DISPLAY or WAYLAND_DISPLAY names a live display, then retry.',
  },
]

annotations: { destructiveHint: true, openWorldHint: false }
// Note: no elicit guard — clipboard write is low-blast-radius and immediately reversible
// by the user (they can copy something else). destructiveHint covers client approval flows.
```

### `clipboard_inspect`

```ts
input: z.object({})  // no parameters

output: z.object({
  primaryFormat: z.enum(['text', 'html', 'rtf', 'image', 'empty'])
    .describe(
      'The richest format explicitly present on the clipboard ' +
      '(image > html > rtf > text). "empty" if the clipboard has no recognized content.'
    ),
  availableFormats: z.array(z.enum(['text', 'html', 'rtf', 'image']))
    .describe('The semantic formats clipboard_read can return — a format is listed only when at least one of its representations was read. One exception: an image whose bytes no decoder accepts is listed, but reading it as "image" fails format_unavailable ("auto" moves on to the next format).'),
  rawTypes: z.array(z.object({
    type: z.string().describe('UTI or pasteboard type identifier (e.g., "public.utf8-plain-text", "public.html").'),
    bytes: z.number().int().optional().describe(
      'Measured size of this representation in bytes; 0 means present and empty. ' +
      'Absent when the platform did not size this type or when measurementFailed is true.'
    ),
    measurementFailed: z.boolean().optional().describe(
      'True when the platform listed this type but its data was nil, null, or failed to read; its format is not available.'
    ),
  })).describe('Every type the platform lists, including translations it can supply, with byte sizes where measured.'),
})

errors: [
  {
    reason: 'inspect_unreadable',
    code: JsonRpcErrorCode.SerializationError,
    when: 'The platform clipboard helper returned output this server could not read',
    recovery: 'Retry clipboard_inspect once; if it fails again, copy the content afresh.',
  },
  {
    reason: 'clipboard_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The platform clipboard helper is missing from PATH, or it cannot reach the desktop session (no display or compositor)',
    recovery: 'Install the clipboard helper (Linux X11: apt install xclip; Wayland: apt install wl-clipboard; Windows: PowerShell 5.1+), or run the server inside the desktop session so DISPLAY or WAYLAND_DISPLAY names a live display, then retry.',
  },
]

annotations: { readOnlyHint: true, openWorldHint: false }
```

### `format()` requirements

Each tool's `format()` function must render all fields from the output schema — both surfaces must carry the same data since some MCP clients (Claude Desktop) forward `content[]` from `format()`, while others (Claude Code) read `structuredContent`.

| Tool | `format()` must include |
|:-----|:------------------------|
| `clipboard_read` | `format`, `byteSize` of `totalByteSize`, `complete`, `nextOffset` when present, `representationId`, and full `content` (fenced) — except for a whole or empty image, which renders a note instead; `width`/`height` when present |
| `clipboard_write` | `format` and `byteSize` of what was written |
| `clipboard_inspect` | `primaryFormat`, `availableFormats` list, `rawTypes` table (type + bytes per row; `unknown` when unsized, plus a `measurementFailed` note when the read failed) |

`clipboard_read` for images: a whole image rides `content[]` as an `image/png` block, so `format()` renders the dimensions and byte size, not the raw base64 (which would be unreadable as markdown and duplicate the block). A partial image slice has no block — it is a PNG byte chunk, not a decodable image — so `format()` renders its byte range, its base64 in a fenced block identical to `structuredContent.content`, and the instruction to base64-decode each chunk separately and concatenate the bytes in offset order.

---

## Security

### Command injection prevention

The server shells out to platform-specific clipboard tools (`osascript`, `xclip`, `xsel`, `wl-paste`, `wl-copy`, `powershell`). Every subprocess is a potential injection vector.

**Hard rule: content never reaches a command line or script source.** Every write sends its payload on stdin: raw bytes to `xclip`/`wl-copy`, and a JSON envelope of base64 fields to the static macOS and Windows writer scripts, whose argv is identical for every payload. Read scripts interpolate only validated non-negative integers (byte offsets and limits).

| Vector | Risk | Mitigation |
|:-------|:-----|:-----------|
| `clipboard_write` content → subprocess | Content with shell metacharacters could escape | Use `child_process.spawn` with `shell: false`; every payload travels on stdin, never in argv. |
| JXA scripts via `osascript` (macOS) | String interpolation into JXA could allow code execution | One static writer script (`JXA_WRITE`); the payload is a stdin JSON envelope of base64 fields, parsed as data. |
| PowerShell commands (Windows) | Script injection via clipboard content | One static writer script (`PS_WRITE`); the payload is a stdin JSON envelope of base64 fields, parsed with `ConvertFrom-Json`. |
| `xclip`/`wl-paste` arguments (Linux) | Flag injection via content | Content goes to stdin; MIME types for `-t` flag come from validated enums, not user input. |
| Clipboard READ content | Malicious clipboard content could be crafted to inject into downstream processing | Not our problem — the server faithfully returns what's on the clipboard. But: never use read content in subsequent shell commands internally without sanitization (defense in depth). |

### Size limits

LLM context windows make large clipboard data impractical. 1MB of text is ~250K tokens — already most of a context window. Limits are intentionally tight:

| Concern | Limit | Rationale |
|:--------|:------|:----------|
| Text read | 512KB | ~128K tokens. Generous for any reasonable clipboard text. |
| HTML/RTF read | 512KB | Same rationale. |
| Image read (base64 PNG) | 5MB raw (→ ~6.7MB base64) | Multimodal models handle images natively; base64 is a transport encoding, not token-counted. Still — 5MB PNG is a large screenshot. |
| Write content | 1MB | Writing large content to clipboard is valid (it goes to the system, not the LLM). Slightly higher than read limit. |
| Inspect (type listing) | No limit | Just metadata — always small. |

When a limit is exceeded, return `content_too_large` error with `{ bytes: number, limit: number, format: string }` — the agent knows the content exists and how large it is, and can decide whether to request a different format or skip.

### Platform isolation

- Backend selected at startup based on `process.platform` and environment detection
- Missing clipboard tools → clear startup error with install guidance (not a silent fallback)
- The server reads and writes the clipboard of the machine it runs on. Stdio is the default; HTTP mode listens on `MCP_HTTP_HOST` (default `127.0.0.1`) for local clients.

---

## Testing Strategy

### Unit tests (per tool, per backend)

Every tool gets a test file. Backend adapters are mocked — no actual clipboard mutation in unit tests.

| Tool | Happy paths | Error paths | Edge cases |
|:-----|:-----------|:------------|:-----------|
| `clipboard_inspect` | Text on clipboard → returns types + sizes | Empty clipboard → `primaryFormat: "empty"`; helper missing or display unreachable → `clipboard_unavailable` | Multiple rich types simultaneously (HTML + text + image from browser copy) |
| `clipboard_read` | Read text, HTML, RTF, image independently | Format not present → `format_unavailable` error; clipboard tool missing or display unreachable → `clipboard_unavailable`; `auto` on empty clipboard → `format_unavailable`; `auto` over an unreadable type listing → `inspect_unreadable`; a stale `representationId`, or a change during the read → `representation_changed` | `auto` with only text; `auto` with image; zero-byte representation → empty success (no image block for a zero-byte image); partial image slices → no image block, base64 and byte range in the text, chunks reassemble byte for byte; same-size replacement between slices; `auto` resolving to another format mid-read; unicode/emoji round-trip; very large content near size cap |
| `clipboard_write` | Write text, verify via read; on macOS and Windows, write HTML and verify both representations; on Linux, verify `text/html` and what plain-text requests receive | Clipboard tool missing or display unreachable → `clipboard_unavailable`; content at 1MB+1 → `content_too_large` | Unicode, emoji, HTML with special chars (`<script>`, `&amp;`), empty string, very large content; X11 write resolves while the forked `xclip` keeps serving |

`tests/tools/native-outcomes.test.ts` runs the three tools through `runToolContract` over the real service and backends, faking only `spawn` with modeled helpers that print the verbatim diagnostics of both `wl-clipboard` and both `xclip` generations.

### Backend adapter tests

Each backend gets its own test suite verifying the adapter contract:

| Backend | Tests |
|:--------|:------|
| `MacosBackend` | JXA type listing (nil data → `measurementFailed`), JXA text/HTML/RTF/image read with both `changeCount` samples, stdin-fed writer (constant argv, envelope on stdin, failed set → error); `macos-native.test.ts` (darwin only) runs the real scripts through `osascript` — see below |
| `LinuxX11Backend` | `xclip` text round-trip, MIME type listing via `-t TARGETS`, presence decided from `TARGETS`, HTML/image read via `-t`, SHA-256 revision over the streamed representation, every `xclip`/`xsel` diagnostic classified (0.13 and git spellings), write settling on the foreground exit, missing `xclip`/`xsel` detection |
| `LinuxWaylandBackend` | `wl-paste`/`wl-copy` text round-trip, `--list-types`, `--no-newline` on every payload read and measurement, HTML/image read, SHA-256 revision over the streamed representation, every `wl-paste`/`wl-copy` diagnostic classified (≤ 2.1 and ≥ 2.2 spellings), missing `wl-paste`/`wl-copy` detection |
| `WindowsBackend` | PowerShell text read (skipping a listed format that yields no string), .NET Clipboard format listing (null/throwing `GetData` and non-string text/RTF data → `measurementFailed`, non-byte objects unsized), stdin-fed writer (constant argv, CF_HTML `MemoryStream`, `UnicodeText` fallback), CF_HTML fragment reads through a modeled helper (one- and two-call paths, changed clipboard → `representation_changed`, malformed header, headerless payload), in-helper SHA-256 revision over the full representation on every sliced read, image read (a decodable `PNG` before `GetImage()`, decoded dimensions, zero-length `PNG`), PowerShell not available detection. `cf-html.test.ts` proves the CF_HTML grammar with byte-offset tests; the generated PowerShell is asserted on, never run by the suite — native Windows clipboard behavior is not exercised |

Most backend tests mock `child_process.spawn` — they verify the commands, arguments, and stdin constructed, not that the actual clipboard works. A mocked `spawn` cannot see an argv-size failure (`E2BIG`), a helper's format sniffing, or a runtime error inside a generated script, so `tests/services/clipboard/macos-native.test.ts` (skipped off darwin) runs `MacosBackend` against the real `osascript`: its `spawn` passes through after rewriting the script's single `$.NSPasteboard.generalPasteboard` to a uniquely named private pasteboard, refuses `pbcopy`/`pbpaste`, and checks the general pasteboard's `changeCount` is unchanged afterwards. It covers 1 MiB HTML and text writes, RTF/EPS-header text writes, byte-exact round-trips, reads below/at/past the end, absent types, declared types with nil data, BOM-led and UTF-16 text and HTML, zero-length and undecodable images (through `clipboard_inspect` and `clipboard_read` as well as the backend), and the `changeCount` revision — stable across whole, sliced, and past-the-end reads, moved by a same-size rewrite, and a rewrite spliced into the script between its two samples failing `representation_changed` for every format.

### Platform integration tests

Run on the actual platform, exercise real clipboard operations. Gated by `process.platform` and CLI tool availability checks in test setup.

- **Round-trip tests**: write → inspect → read cycle for text and HTML
- **Image read** (when image on clipboard): verify base64 is valid PNG, dimensions match
- **Type detection accuracy**: verify `inspect` reports correctly for platform-native clipboard state
- **Unicode round-trip**: write/read unicode, emoji, CJK, RTL text
- **Empty clipboard**: clear → inspect → verify empty state
- **Save/restore**: `beforeEach`/`afterEach` saves and restores clipboard state so tests don't clobber user's clipboard

### Security tests (dedicated test file, all platforms)

Injection payloads tested against every tool and every backend:

```ts
const INJECTION_PAYLOADS = [
  '"; $(whoami); "',                   // shell command substitution
  "'; `id`; '",                        // backtick execution
  '$(cat /etc/passwd)',                // subshell
  '\n; rm -rf /',                      // newline + command
  '\\"; process.exit(); //',           // JXA breakout
  "'); ObjC.import('Foundation'); //", // JXA ObjC injection
  '; Invoke-Expression "whoami"',      // PowerShell injection
  '| cat /etc/passwd',                 // pipe injection
  '\x00',                              // null byte
  'a'.repeat(1_000_000),              // size bomb
];
```

For each backend and each tool with string input:
- Pass each payload as clipboard write content
- Verify: subprocess spawned with content on stdin, NOT in command args
- Verify: no shell interpretation occurred (content round-trips literally)
- Size boundary tests: text at 512KB, 512KB+1; image at 5MB, 5MB+1; write at 1MB+1
- Concurrent access: multiple rapid read/write cycles don't corrupt

### Mocking strategy

- Backend adapters implement a `ClipboardBackend` interface — mock the interface, not the subprocess calls, for tool-level tests
- Backend-level tests mock `child_process.spawn` to verify correct command construction; the darwin-only native suite runs the real JXA against a private pasteboard
- Integration tests (`tests/integration/`) put stub `osascript`/`xclip`/`xsel`/`wl-copy`/`wl-paste` first on the server's `PATH`, so they never touch the real clipboard
- Tests run locally (`bun run test`); there is no CI test matrix. The native suite runs only on macOS, and the Linux and Windows backends are covered at the spawn seam

---

## Platform Capabilities

Not all formats are available on all platforms:

| Capability | macOS | Linux (X11/Wayland) | Windows |
|:-----------|:------|:--------------------|:--------|
| Text read/write | Yes | Yes | Yes |
| HTML read/write | Yes (JXA) | Yes (`text/html` MIME) | Yes (.NET) |
| HTML plain-text fallback on write | Yes | No — plain-text requests can receive the HTML markup itself | Yes |
| RTF read | Yes (JXA) | Partial (if app sets `text/rtf`) | Yes (.NET) |
| Image read (PNG) | Yes (JXA, TIFF→PNG) | Yes (`image/png` MIME) | Yes (.NET: registered `PNG`, else Bitmap→PNG) |
| Type inspection | Yes (`pb.types`) | Yes (`TARGETS` / `--list-types`) | Yes (`.GetFormats()`) |
| Byte size per type | Yes (nil data → `measurementFailed`) | Recognized types only, read to measure | Strings, byte arrays, and streams only |

When a format is unavailable on a platform, `clipboard_read` returns `format_unavailable` with a message noting platform support. `clipboard_inspect` only reports formats actually present.

**Required CLI tools:**
- macOS: none (`osascript` is built in)
- Linux X11: `xclip` (`apt install xclip` / `pacman -S xclip`)
- Linux Wayland: `wl-clipboard` (`apt install wl-clipboard`)
- Windows: PowerShell 5.1+ (built-in on Windows 10+)

---

## Known Limitations

- **No clipboard history.** Only the current state is accessible. History requires a persistent daemon.
- **File references not supported.** The clipboard can hold file paths (Finder copy), but interpreting them is out of scope.
- **RTF write not supported at v1.** RTF output is available for read, but writing RTF requires generating valid RTF markup — deferred until there's demand.
- **Linux byte sizes require full read.** `xclip`/`wl-paste` don't report sizes without reading content. For `inspect`, the backend reads each type to measure — adds latency for large items.
- **Linux clipboard owned by a helper process.** On Wayland and X11, clipboard content is served by the process that copied it — when that process exits, the clipboard empties. `wl-copy` and `xclip -i` each fork a background owner that keeps serving the selection until another client takes it. `clipboard_write` spawns `wl-copy` detached (`detached: true`, then `unref()`), so the background `wl-copy` runs in its own session and keeps serving after the server exits — normally or by `SIGKILL`. Both write paths resolve on the foreground process's exit, not on `close`: the forked owner inherits the stdio pipes, so `close` would wait until another client took the selection.
- **JXA subprocess latency (macOS).** Inspection, every read, and every write spawn one `osascript` process each, measured at ~60–80 ms median (a 1 MiB write included). `clipboard_write` reads the prior text before writing, and `auto` inspects before reading.
- **Translated types (macOS).** `pb.types` also lists types AppKit can translate to (e.g., TIFF from PNG); inspection sizes each one from its actual data, and a listed type with nil data never makes its format available.
- **Undecodable images.** An image representation with bytes that no decoder accepts (data `NSBitmapImageRep` cannot read on macOS, or a `PNG` format `System.Drawing` cannot decode on Windows) is listed with its size, so `clipboard_inspect` reports `image`, but an explicit `image` read of it fails `format_unavailable` unless another image representation decodes; `auto` moves on to the next listed format instead. Telling the two apart at inspection time would mean decoding every image.
