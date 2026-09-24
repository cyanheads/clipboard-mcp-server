<div align="center">
  <h1>@cyanheads/clipboard-mcp-server</h1>
  <p><b>Read, write, and inspect the system clipboard across macOS, Linux (X11/Wayland), and Windows via MCP. STDIO or Streamable HTTP.</b>
  <div>3 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/clipboard-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/clipboard-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/clipboard-mcp-server/releases/latest/download/clipboard-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=clipboard-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2xpcGJvYXJkLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22clipboard-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fclipboard-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

The system clipboard across macOS, Linux (X11/Wayland), and Windows. Read, write, and inspect text, HTML, RTF, and image content from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `clipboard_read` | Read clipboard contents in a specified format (text, HTML, RTF, image, or auto-select richest) |
| `clipboard_write` | Write plain text or HTML to the clipboard, replacing current contents, or clear it outright |
| `clipboard_inspect` | List available clipboard formats and byte sizes without reading full content |

---

## Capability reference

### `clipboard_read` <sub>tool</sub>

- `auto` returns the richest format explicitly present — priority: image > html > rtf > text — moving on to the next one when a listed format can't be read (an image no decoder accepts); `format` requests a specific one instead
- Size limits: 512 KB for text/HTML/RTF, 5 MB for images (raw bytes before base64 expansion)
- Content above the limit reads via `offset`/`limit` slicing — pass `offset` to read a bounded window (`limit` is optional, at least 4, and clamped to the format's size limit) and follow the returned `nextOffset` until `complete` is `true`
- Every read returns `representationId`, an opaque token for the value and format it was cut from — the same across full and sliced reads of an unchanged value. Pass it back with each `nextOffset`: if another application copied in between (even a same-size replacement), or `auto` now resolves to a different format, the continuation returns no bytes and fails with `representation_changed`. Linux and Windows derive it from a SHA-256 of the full representation, macOS from `NSPasteboard.changeCount`
- `image` returns base64-encoded PNG data, with `width`/`height` whenever the capture carries a readable PNG header. Only a response holding the whole image attaches an image block; image slices are PNG byte chunks, not standalone images — a partial slice carries its base64 and byte range in the text, and the chunks are base64-decoded separately and their bytes concatenated in offset order
- A text, HTML, RTF, or image format that is present but zero bytes long returns empty content, not an error (a zero-byte image attaches no image block)
- Typed errors: `format_unavailable` when the requested format isn't on the clipboard (or the clipboard is empty), `content_too_large` when no `offset`/`limit` was given and content exceeds the size limit, `representation_changed` when the clipboard changed after the slice that returned the given `representationId`, or while the read itself was running, `clipboard_unavailable` when the platform helper is missing or can't reach the desktop session, `inspect_unreadable` when `auto` can't read the clipboard's type listing (an explicit format reads without it)

---

### `clipboard_write` <sub>tool</sub>

- Exactly one of `content` or `clear: true` — an empty `content`, both, or neither is rejected as invalid input
- `format: "html"` writes HTML; macOS and Windows also publish an auto-generated, tag-stripped plain-text fallback. Linux has no stripped fallback — Wayland also offers the markup under the plain-text types, and X11 advertises only `text/html` but answers a plain-text request (e.g. `UTF8_STRING`) with the same markup, so a plain-text paste can receive raw HTML
- Typed `clipboard_unavailable` error when the platform helper is missing or can't reach the desktop session
- `clear: true` removes every representation instead of writing (needs `xsel` alongside `xclip` on Linux X11) and returns `cleared: true`, `byteSize: 0`, no `format`
- Returns `previousContent` — the plain text on the clipboard immediately before the write or clear, for undoing an unintended overwrite — absent when the clipboard was empty, held no text representation, or that text exceeded the 512 KB read limit
- Size limit: 1 MB, past which a typed `content_too_large` error is returned
- Not registered when `CLIPBOARD_READ_ONLY` is set, which gates clearing along with writing

---

### `clipboard_inspect` <sub>tool</sub>

- Returns `primaryFormat` (richest present — image > html > rtf > text — or `empty`) and `availableFormats` — only the formats `clipboard_read` can return, each backed by at least one representation that was read (the one exception: an image whose bytes no decoder accepts is listed, but reading it as `image` fails `format_unavailable`, and `auto` moves on to the next format)
- Returns `rawTypes` — every raw platform type identifier (UTIs on macOS, TARGETS on X11/Wayland, format names on Windows) with its measured `bytes`, where `0` means present and empty; a type the platform doesn't size (e.g. `TARGETS`) has no `bytes`, and one whose data was nil or unreadable carries `measurementFailed: true` and no `bytes` — never a false zero
- Typed `inspect_unreadable` error when the platform helper's output cannot be read, instead of reporting an empty clipboard; typed `clipboard_unavailable` when the helper is missing or can't reach the desktop session

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Clipboard-specific:

- Cross-platform backend detection at startup — macOS (osascript/JXA), Linux X11 (xclip), Linux Wayland (wl-clipboard), Windows (PowerShell 5.1+)
- Semantic format mapping — platform-native type identifiers (UTIs, TARGETS, Windows format names) mapped to `text`, `html`, `rtf`, `image` across all backends
- Platform-aware HTML writes — macOS and Windows publish HTML plus a stripped plain-text fallback; on Linux the HTML is the only payload, which plain-text paste targets can also receive
- Image support — every backend returns PNG as base64 with width/height (Linux backends read them from the PNG header)

Agent-friendly output:

- Size-guarded I/O — reads and writes over the format limit fail with a typed `content_too_large` error carrying byte/limit metadata, rather than truncating silently
- Bounded continuation — `clipboard_read` slices oversized content with `offset`/`limit` and `nextOffset` instead of forcing a single all-or-nothing read, and `representationId` makes a clipboard change between slices fail loudly instead of splicing two values together
- Undo support — `clipboard_write` returns `previousContent` so an unintended overwrite can be reverted
- Discriminated failure — `format_unavailable`, `content_too_large`, `representation_changed`, `inspect_unreadable`, and `clipboard_unavailable` are typed reasons with recovery hints, not generic errors; each backend classifies its helper's outcomes itself (across wl-clipboard and xclip release spellings), so an empty clipboard, an absent format, and an unreachable helper never blur together

---

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "clipboard-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/clipboard-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "clipboard-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/clipboard-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

Bun 1.4.0+ or Node.js 24+.

**macOS:** No additional tools required — `osascript` is built in.

**Linux X11:** `xclip` must be installed. `xsel` is additionally required for `clipboard_write`'s `clear` mode — it is the only one of the two that can hand the selection back rather than owning an empty one.

```sh
apt install xclip xsel      # Debian/Ubuntu
pacman -S xclip xsel        # Arch
```

**Linux Wayland:** `wl-clipboard` must be installed.

```sh
apt install wl-clipboard    # Debian/Ubuntu
pacman -S wl-clipboard      # Arch
```

**Windows:** PowerShell 5.1+ (built-in on Windows 10 and later).

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_HOST` | Hostname for HTTP server. | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | Endpoint path for the HTTP server. | `/mcp` |
| `MCP_HTTP_MAX_BODY_BYTES` | Max inbound JSON-RPC request body, in bytes. Raised above the framework's 1 MiB default so a full-size `clipboard_write` survives JSON escaping (worst case costs 6 wire bytes per source byte). `0` disables the guard and defers to the reverse proxy. | `7340032` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. `auto` resolves to `stateful`. This server defaults to `stateless` — it keeps no per-session state. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `CLIPBOARD_READ_ONLY` | Serve the clipboard read-only. When `true`, `clipboard_write` is not registered — absent from `tools/list` and uncallable, though still shown in a disabled state on the manifest and landing page. Accepts `true/false/1/0/yes/no/on/off`; an unrecognized value fails startup. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

```sh
# One-time build
bun run rebuild

# Run the built server
bun run start:stdio
# or
bun run start:http
```

### Checks and tests

```sh
bun run devcheck   # Lint, format, typecheck, security
bun run test       # Vitest test suite
```

---

## Project structure

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | Entry point — registers tools via `createApp()` |
| `src/mcp-server/tools/definitions/` | Tool definitions: `clipboard_read`, `clipboard_write`, `clipboard_inspect` |
| `src/services/clipboard/` | Platform backends (macOS, Linux X11, Wayland, Windows) and service facade |
| `tests/` | Vitest tests for tools and backends |
| `framework-skills/` | Agent workflow skills (add-tool, field-test, polish-docs-meta, etc.) |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for the full developer protocol — tool patterns, service patterns, error handling, logging conventions, and the checklist for shipping changes. The short version:

- Handlers throw, framework catches — tool logic catches only to act on a backend's typed outcome: map it to a declared error reason, or move `auto` on to the next format
- Use `ctx.log` for request-scoped logging
- No Docker — this server needs direct host OS access (JXA/NSPasteboard, xclip, wl-clipboard, PowerShell), none of which work inside a container

---

## Contributing

Issues welcome at [github.com/cyanheads/clipboard-mcp-server](https://github.com/cyanheads/clipboard-mcp-server). Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache 2.0 — see [`LICENSE`](./LICENSE).
