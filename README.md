<div align="center">
  <h1>@cyanheads/clipboard-mcp-server</h1>
  <p><b>Read, write, and inspect the system clipboard across macOS, Linux (X11/Wayland), and Windows via MCP. STDIO or Streamable HTTP.</b>
  <div>3 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/clipboard-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/clipboard-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/clipboard-mcp-server/releases/latest/download/clipboard-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=clipboard-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2xpcGJvYXJkLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22clipboard-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fclipboard-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

3 tools for reading, writing, and inspecting the system clipboard:

| Tool | Description |
|:---|:---|
| `clipboard_read` | Read clipboard contents in a specified format (text, HTML, RTF, image, or auto-select richest) |
| `clipboard_write` | Write plain text or HTML to the clipboard, replacing current contents |
| `clipboard_inspect` | List available clipboard formats and byte sizes without reading full content |

### `clipboard_read`

Read the current clipboard contents in a requested format.

- `auto` mode returns the richest format explicitly present — priority: image > html > rtf > text
- `image` returns base64-encoded PNG data with pixel dimensions
- `html` returns raw HTML source as copied from a browser
- `rtf` returns raw RTF markup
- `text` returns plain text
- Size limits: 512 KB for text/HTML/RTF, 5 MB for images (raw bytes before base64 expansion)
- Returns a typed `format_unavailable` error when the requested format is not on the clipboard — use `clipboard_inspect` first to check availability

---

### `clipboard_write`

Write content to the clipboard, replacing current contents.

- `text` writes plain text
- `html` writes HTML with an auto-generated plain-text fallback (tag-stripped), so paste targets that only accept plain text still receive something useful
- Size limit: 1 MB
- `destructiveHint: true` — replaces whatever is currently on the clipboard

---

### `clipboard_inspect`

List the formats and byte sizes of what is currently on the clipboard without reading the full content.

- Returns `primaryFormat` — the richest format present (image > html > rtf > text), or `empty`
- Returns `availableFormats` — all semantic formats present, for deciding which format to pass to `clipboard_read`
- Returns `rawTypes` — all raw platform type identifiers with byte sizes (UTIs on macOS, TARGETS on X11/Wayland, format names on Windows)
- Use this before `clipboard_read` to avoid `format_unavailable` errors and to check content size before reading

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Structured logging with optional OpenTelemetry tracing
- Runs locally via stdio or HTTP from the same codebase

Clipboard-specific:

- Cross-platform backend detection at startup — macOS (pbcopy/pbpaste + osascript), Linux X11 (xclip), Linux Wayland (wl-clipboard), Windows (PowerShell 5.1+)
- Semantic format mapping — platform-native type identifiers (UTIs, TARGETS, Windows format names) mapped to `text`, `html`, `rtf`, `image` across all backends
- Size-guarded reads and writes — typed `ContentTooLargeError` with byte/limit metadata before content returns
- HTML write with automatic plain-text fallback — stripped and written alongside HTML for apps that only paste plain text
- Image support — macOS and Windows backends decode PNG bytes and return width/height alongside base64 content

---

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "clipboard": {
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
    "clipboard": {
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

Or with Docker:

```json
{
  "mcpServers": {
    "clipboard": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/clipboard-mcp-server:latest"
      ]
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

**macOS:** No additional tools required — `pbcopy`, `pbpaste`, and `osascript` are built in.

**Linux X11:** `xclip` must be installed.

```sh
apt install xclip           # Debian/Ubuntu
pacman -S xclip             # Arch
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
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

### Docker

```sh
docker build -t clipboard-mcp-server .
docker run -p 3010:3010 clipboard-mcp-server
```

---

## Project structure

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | Entry point — registers tools via `createApp()` |
| `src/mcp-server/tools/definitions/` | Tool definitions: `clipboard_read`, `clipboard_write`, `clipboard_inspect` |
| `src/services/clipboard/` | Platform backends (macOS, Linux X11, Wayland, Windows) and service facade |
| `tests/` | Vitest tests for tools and backends |
| `skills/` | Agent workflow skills (add-tool, field-test, polish-docs-meta, etc.) |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for the full developer protocol — tool patterns, service patterns, error handling, logging conventions, and the checklist for shipping changes.

---

## Contributing

Issues and pull requests welcome at [github.com/cyanheads/clipboard-mcp-server](https://github.com/cyanheads/clipboard-mcp-server).

---

## License

Apache 2.0 — see [`LICENSE`](./LICENSE).
