#!/usr/bin/env node
/**
 * @fileoverview clipboard-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { config, resetConfig } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from './config/server-config.js';
import { clipboardInspect } from './mcp-server/tools/definitions/clipboard-inspect.tool.js';
import { clipboardRead } from './mcp-server/tools/definitions/clipboard-read.tool.js';
import { clipboardWrite } from './mcp-server/tools/definitions/clipboard-write.tool.js';
import { initClipboardService } from './services/clipboard/clipboard-service.js';

/**
 * Server-chosen defaults for two framework settings, applied the way the
 * framework applies its own `name`/`version` overrides: write to `process.env`,
 * then re-parse.
 *
 * Order matters. The framework loads `.env` lazily, on the first `config`
 * property read, and dotenv never overwrites a key already in `process.env`.
 * Reading a property first therefore loads `.env` before `??=` runs, leaving
 * precedence at shell env > `.env` > these defaults. Applying the defaults
 * before that read would shadow an operator's `.env` value.
 */
void config.mcpTransportType;

/**
 * 7 MiB. `clipboard_write` accepts 1 MiB of content, and a control character
 * with no short JSON escape costs 6 wire bytes per source byte — so the largest
 * valid call frames to roughly 6.3 MB. At the framework's 1 MiB default the
 * transport answers 413 before the handler can return its declared
 * `content_too_large` error.
 */
process.env.MCP_HTTP_MAX_BODY_BYTES ??= '7340032';

/**
 * Nothing here keys on a session: `ctx.state` is tenant-scoped and every call
 * reads the live OS clipboard. Stateless drops the session store and the
 * per-session `McpServer` allocation.
 */
process.env.MCP_SESSION_MODE ??= 'stateless';

resetConfig();

const { readOnly } = getServerConfig();

const writeTool = readOnly
  ? disabledTool(clipboardWrite, {
      reason: 'This deployment is read-only: CLIPBOARD_READ_ONLY is set.',
      hint: 'Unset CLIPBOARD_READ_ONLY (or set it to false) to enable the write tool.',
    })
  : clipboardWrite;

/**
 * Session-level guidance. Write behavior is described only when the write tool
 * is actually registered — a read-only deployment must not point a client at a
 * tool that is absent from `tools/list`.
 */
function buildInstructions(writeEnabled: boolean): string {
  const lead = writeEnabled
    ? 'Use the clipboard_* tools to read, write, and inspect the local system clipboard (macOS, Linux X11/Wayland, and Windows; no API key).'
    : 'Use the clipboard_* tools to read and inspect the local system clipboard (macOS, Linux X11/Wayland, and Windows; no API key).';
  const slot = writeEnabled
    ? 'There is no history — the clipboard is a single live slot, so clipboard_read returns whatever is on it right now and clipboard_write replaces it.'
    : 'There is no history — the clipboard is a single live slot, so clipboard_read returns whatever is on it right now.';
  const formats =
    'A clipboard holds one item in several formats (text/html/rtf/image); call clipboard_inspect first to see what is present, and prefer clipboard_read with format "auto". Images come back as base64 PNG.';
  return `${lead} ${slot} ${formats}`;
}

await createApp({
  name: 'clipboard-mcp-server',
  title: 'clipboard-mcp-server',
  instructions: buildInstructions(!readOnly),
  tools: [clipboardInspect, clipboardRead, writeTool],
  resources: [],
  prompts: [],
  async setup(core) {
    await initClipboardService(core.config, core.storage);
  },
});
