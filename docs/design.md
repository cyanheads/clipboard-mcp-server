# clipboard-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `clipboard_read` | Read the current clipboard contents in a requested format. For `auto`, returns the richest explicitly-set format available (image > html > rtf > text). Images are returned as base64-encoded PNG with dimensions. | `format: "text" \| "html" \| "rtf" \| "image" \| "auto"` | `readOnlyHint: true`, `openWorldHint: false` |
| `clipboard_write` | Write content to the clipboard. `text` sets plain text. `html` publishes HTML on every platform; macOS and Windows also publish a stripped plain-text fallback. | `content: string`, `format: "text" \| "html"` | `destructiveHint: true` (replaces current contents) |
| `clipboard_inspect` | List the explicitly-set types on the clipboard with byte sizes and a semantic summary. Useful for deciding which format to request before calling `clipboard_read`. No content returned. | _(none)_ | `readOnlyHint: true`, `openWorldHint: false` |

### Resources

None. All clipboard access is ephemeral; stable URIs don't apply here.

### Prompts

None. Pure data/action server.

---

## Overview

`clipboard-mcp-server` gives agents structured access to the system clipboard across macOS, Linux, and Windows. Agents can read the current contents (plain text, HTML, RTF, or image), write new content, and inspect available formats without fetching full content. No history, no monitoring — just the current clipboard state.

The primary use case: agents that need to receive content a user has copied (a URL, a code snippet, an error message, HTML from a browser selection) without requiring the user to paste it into the conversation. Write support lets agents stage output for the user to paste elsewhere.

**Platform backends:**
- **macOS**: `pbcopy`/`pbpaste` for text, JXA/NSPasteboard for rich types (HTML, RTF, image)
- **Linux**: `xclip` (X11) or `wl-clipboard` (Wayland) — detected at startup
- **Windows**: .NET `System.Windows.Forms.Clipboard` via PowerShell for text and rich types

The tool surface is platform-agnostic — same tools, same schemas, same behavior. Platform differences are encapsulated in the service layer. Feature availability varies by platform (see Platform Capabilities below).

---

## Requirements

- Read current clipboard: plain text, HTML, RTF, image (base64 PNG)
- Write current clipboard: plain text or HTML; HTML includes a stripped plain-text fallback on macOS and Windows
- Inspect clipboard types and byte sizes without fetching full content
- Cross-platform: macOS, Linux (X11 + Wayland), Windows
- Platform detection at startup — select appropriate backend, error if clipboard tools not available
- No clipboard history, no polling/watching, no file references
- Local stdio deployment only — no HTTP transport needed for this use case
- No auth required (local user's own clipboard)

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ClipboardService` | Platform-specific clipboard backends (see below) | All three tools |

The service uses a **backend adapter pattern** — a common interface (`ClipboardBackend`) with platform-specific implementations:

| Backend | Platform | Text | HTML | RTF | Image | Inspect |
|:--------|:---------|:-----|:-----|:----|:------|:--------|
| `MacosBackend` | darwin | `pbcopy`/`pbpaste` | JXA NSPasteboard | JXA NSPasteboard | JXA NSPasteboard (TIFF→PNG) | JXA `pb.types` |
| `LinuxX11Backend` | linux (X11) | `xclip -selection clipboard` | `xclip -t text/html` | `xclip -t text/rtf` | `xclip -t image/png` | `xclip -o -t TARGETS` |
| `LinuxWaylandBackend` | linux (Wayland) | `wl-paste` / `wl-copy` | `wl-paste -t text/html` | `wl-paste -t text/rtf` | `wl-paste -t image/png` | `wl-paste --list-types` |
| `WindowsBackend` | win32 | PowerShell .NET Forms.Clipboard | PowerShell .NET Forms.Clipboard | PowerShell .NET | PowerShell .NET (BitmapSource→PNG) | PowerShell `GetDataObject().GetFormats()` |

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

1. `ClipboardService` — platform guard, `readText`/`writeText` via pbcopy/pbpaste, `readRich`/`writeHtml`/`inspectTypes` via JXA subprocess
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

**Critical distinction**: use `pb.types` (explicitly-set types) rather than `availableTypeFromArray` for format detection. macOS synthesizes types on demand (a text clipboard returns `true` for a PNG availability check via `availableTypeFromArray`), so only explicit types reflect what was actually copied. Verified: `pb.stringForType($.NSPasteboardTypeHTML)` returns null for plain-text clipboards despite `availableTypeFromArray` claiming it's available.

### Image output: always PNG

macOS copies images as TIFF internally. The tool always returns PNG (converting TIFF via `NSBitmapImageRep.imageRepWithData` + `representationUsingTypeProperties(NSBitmapImageFileTypePNG, {})`). Verified working. PNG is the only practical base64-over-JSON image format — TIFF is a container format most downstream consumers don't handle.

### HTML write: platform-dependent representations

On macOS and Windows, HTML writes publish both HTML and an auto-generated, tag-stripped plain-text fallback. This matches browser clipboard behavior and gives plain-text-only paste targets a usable representation. Linux X11 and Wayland publish `text/html` only because their current command-line backends do not provide the same multi-representation ownership contract.

### pbcopy/pbpaste for text, JXA for everything else

`pbcopy`/`pbpaste` are the canonical macOS text clipboard tools — fast, no dependencies, handle unicode and emoji correctly (verified). JXA via `osascript -l JavaScript` is required for rich types (HTML, RTF, image) and for `inspect`. The service layer picks the right backend per operation; callers don't see this distinction.

### `pbcopy` stdin encoding

`pbpaste` outputs UTF-8. `pbcopy` reads stdin as UTF-8. Confirmed unicode and emoji round-trip correctly (`Hello 世界 🌍`).

---

## Tool Contracts

### `clipboard_read`

```ts
input: z.object({
  format: z.enum(['text', 'html', 'rtf', 'image', 'auto'])
    .default('auto')
    .describe(
      'Format to return. "auto" returns the richest format explicitly present on the clipboard ' +
      '(priority: image > html > rtf > text). "image" returns base64-encoded PNG with dimensions. ' +
      '"html" returns raw HTML source as copied from a browser. "rtf" returns raw RTF markup. ' +
      '"text" returns plain text. If the requested format is not on the clipboard, ' +
      'the tool returns an error — use "auto" when unsure, or call clipboard_inspect first.'
    ),
})

output: z.object({
  format: z.enum(['text', 'html', 'rtf', 'image'])
    .describe('The format actually returned (relevant when input was "auto").'),
  content: z.string()
    .describe('Clipboard contents. For "image", base64-encoded PNG data.'),
  width: z.number().int().optional()
    .describe('Image width in pixels. Present only when format is "image".'),
  height: z.number().int().optional()
    .describe('Image height in pixels. Present only when format is "image".'),
  byteSize: z.number().int()
    .describe('Size of the content in bytes.'),
})

errors: [
  {
    reason: 'format_unavailable',
    code: JsonRpcErrorCode.NotFound,
    when: 'Requested format is not present on the clipboard',
    recovery: 'Call clipboard_inspect to see available formats, then retry with a supported format or use "auto".',
  },
  {
    reason: 'content_too_large',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Clipboard content exceeds size limit (512KB text/HTML/RTF, 5MB image)',
    data: { bytes: number, limit: number, format: string },
    recovery: 'Content is too large to return. Use clipboard_inspect to see available formats and sizes, then decide whether to request a smaller format.',
  },
  {
    reason: 'clipboard_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Required clipboard tool not found on this platform',
    recovery: 'Install the platform clipboard tool: macOS (built-in), Linux X11 (xclip), Linux Wayland (wl-clipboard), Windows (PowerShell 5.1+).',
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
      'tag-stripped plain-text fallback. Linux X11 and Wayland publish only text/html.'
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
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Write content exceeds the 1MB size limit',
    data: { bytes: number, limit: number },
    recovery: 'Content is too large to write to the clipboard. Truncate or summarize before writing.',
  },
  {
    reason: 'clipboard_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Required clipboard tool not found on this platform',
    recovery: 'Install the platform clipboard tool: macOS (built-in), Linux X11 (xclip), Linux Wayland (wl-clipboard), Windows (PowerShell 5.1+).',
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
    .describe('All semantic formats present. Use to decide which format to pass to clipboard_read.'),
  rawTypes: z.array(z.object({
    type: z.string().describe('UTI or pasteboard type identifier (e.g., "public.utf8-plain-text", "public.html").'),
    bytes: z.number().int().describe(
      'Size of this representation in bytes. ' +
      'On Linux, sizes are measured by reading each format — may add latency for large clipboard items.'
    ),
  })).describe('All explicitly-set pasteboard types with byte sizes. Useful for debugging or understanding exactly what was copied.'),
})

errors: [
  {
    reason: 'clipboard_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Required clipboard tool not found on this platform',
    recovery: 'Install the platform clipboard tool: macOS (built-in), Linux X11 (xclip), Linux Wayland (wl-clipboard), Windows (PowerShell 5.1+).',
  },
]

annotations: { readOnlyHint: true, openWorldHint: false }
```

### `format()` requirements

Each tool's `format()` function must render all fields from the output schema — both surfaces must carry the same data since some MCP clients (Claude Desktop) forward `content[]` from `format()`, while others (Claude Code) read `structuredContent`.

| Tool | `format()` must include |
|:-----|:------------------------|
| `clipboard_read` | `format`, `byteSize`, and full `content` (or a byte-count summary when content is binary/base64); `width`/`height` when present |
| `clipboard_write` | `format` and `byteSize` of what was written |
| `clipboard_inspect` | `primaryFormat`, `availableFormats` list, `rawTypes` table (type + bytes per row) |

`clipboard_read` for images: `content` is a large base64 string — `format()` should render the image dimensions and byte size, not the raw base64 (which would be unreadable as markdown and bloat the `content[]` surface). Use `structuredContent` for the actual base64 data.

---

## Security

### Command injection prevention

The server shells out to platform-specific clipboard tools (`pbcopy`, `xclip`, `wl-copy`, `powershell`, `osascript`). Every subprocess is a potential injection vector.

**Hard rule: raw content is never interpolated into command strings.** Text content is piped via stdin where the platform tool supports it. The macOS and Windows rich-format scripts receive only JSON-quoted base64 literals inside fixed script templates.

| Vector | Risk | Mitigation |
|:-------|:-----|:-----------|
| `clipboard_write` content → subprocess | Content with shell metacharacters could escape | Use `child_process.spawn` with `shell: false`; pass raw text via stdin or JSON-quoted base64 through a fixed script template. |
| JXA scripts via `osascript` (macOS) | String interpolation into JXA could allow code execution | Encode both HTML and its plain-text fallback as base64, then embed only JSON-quoted base64 literals in a fixed JXA template. |
| PowerShell commands (Windows) | Script injection via clipboard content | Encode text and HTML representations as base64, then embed only JSON-quoted base64 literals in fixed PowerShell templates. |
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
- No network transport — stdio only. This server never listens on a port.

---

## Testing Strategy

### Unit tests (per tool, per backend)

Every tool gets a test file. Backend adapters are mocked — no actual clipboard mutation in unit tests.

| Tool | Happy paths | Error paths | Edge cases |
|:-----|:-----------|:------------|:-----------|
| `clipboard_inspect` | Text on clipboard → returns types + sizes | Empty clipboard → `primaryFormat: "empty"` | Multiple rich types simultaneously (HTML + text + image from browser copy) |
| `clipboard_read` | Read text, HTML, RTF, image independently | Format not present → `format_unavailable` error; clipboard tool missing → `clipboard_unavailable`; `auto` on empty clipboard → `format_unavailable` | `auto` with only text; `auto` with image; unicode/emoji round-trip; very large content near size cap |
| `clipboard_write` | Write text, verify via read; on macOS and Windows, write HTML and verify both representations; on Linux, verify `text/html` | Clipboard tool missing → `clipboard_unavailable`; content at 1MB+1 → `content_too_large` | Unicode, emoji, HTML with special chars (`<script>`, `&amp;`), empty string, very large content |

### Backend adapter tests

Each backend gets its own test suite verifying the adapter contract:

| Backend | Tests |
|:--------|:------|
| `MacosBackend` | `pbcopy`/`pbpaste` text round-trip, JXA type listing, JXA HTML/RTF/image read, HTML write dual-representation, TIFF→PNG conversion |
| `LinuxX11Backend` | `xclip` text round-trip, MIME type listing via `-t TARGETS`, HTML/image read via `-t`, missing `xclip` detection |
| `LinuxWaylandBackend` | `wl-paste`/`wl-copy` text round-trip, `--list-types`, HTML/image read, missing `wl-paste` detection |
| `WindowsBackend` | PowerShell text round-trip, .NET Clipboard format listing, HTML/image read via .NET, PowerShell not available detection |

All backend tests mock `child_process.spawn` — they verify the correct commands and arguments are constructed, not that the actual clipboard works.

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
- Backend-level tests mock `child_process.spawn` to verify correct command construction
- Integration tests run on real platform with real clipboard — only in environments where clipboard tools are available
- CI matrix: macOS, Ubuntu (X11), Windows — each runs platform-specific integration tests

---

## Platform Capabilities

Not all formats are available on all platforms:

| Capability | macOS | Linux (X11/Wayland) | Windows |
|:-----------|:------|:--------------------|:--------|
| Text read/write | Yes | Yes | Yes |
| HTML read/write | Yes (JXA) | Yes (`text/html` MIME) | Yes (.NET) |
| HTML plain-text fallback on write | Yes | No | Yes |
| RTF read | Yes (JXA) | Partial (if app sets `text/rtf`) | Yes (.NET) |
| Image read (PNG) | Yes (JXA, TIFF→PNG) | Yes (`image/png` MIME) | Yes (.NET, BitmapSource→PNG) |
| Type inspection | Yes (`pb.types`) | Yes (`TARGETS` / `--list-types`) | Yes (`.GetFormats()`) |
| Byte size per type | Yes | Partial (must read to measure) | Partial (must read to measure) |

When a format is unavailable on a platform, `clipboard_read` returns `format_unavailable` with a message noting platform support. `clipboard_inspect` only reports formats actually present.

**Required CLI tools:**
- macOS: none (pbcopy/pbpaste are built-in; osascript is built-in)
- Linux X11: `xclip` (`apt install xclip` / `pacman -S xclip`)
- Linux Wayland: `wl-clipboard` (`apt install wl-clipboard`)
- Windows: PowerShell 5.1+ (built-in on Windows 10+)

---

## Known Limitations

- **No clipboard history.** Only the current state is accessible. History requires a persistent daemon.
- **File references not supported.** The clipboard can hold file paths (Finder copy), but interpreting them is out of scope.
- **RTF write not supported at v1.** RTF output is available for read, but writing RTF requires generating valid RTF markup — deferred until there's demand.
- **Linux byte sizes require full read.** `xclip`/`wl-paste` don't report sizes without reading content. For `inspect`, the backend reads each type to measure — adds latency for large items.
- **Wayland clipboard ephemeral.** On Wayland, clipboard content is owned by the source process — if the process that copied exits, the clipboard empties. `clipboard_write` must invoke `wl-copy` as a detached background process (using `child_process.spawn` with `detached: true` and `unref()`) so the content persists after the MCP server process moves on. If the server itself exits, the background `wl-copy` process will also exit and the clipboard will empty.
- **JXA subprocess latency (macOS).** Rich-type operations spawn an `osascript` process (~50–100ms on cold start). Text operations via pbcopy/pbpaste are faster (~5ms).
- **Synthesized types (macOS).** macOS synthesizes some types on demand (e.g., TIFF from PNG). The service uses `pb.types` (explicit types only) to avoid false positives.
