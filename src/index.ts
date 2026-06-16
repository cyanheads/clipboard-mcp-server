#!/usr/bin/env node
/**
 * @fileoverview clipboard-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { clipboardInspect } from './mcp-server/tools/definitions/clipboard-inspect.tool.js';
import { clipboardRead } from './mcp-server/tools/definitions/clipboard-read.tool.js';
import { clipboardWrite } from './mcp-server/tools/definitions/clipboard-write.tool.js';
import { initClipboardService } from './services/clipboard/clipboard-service.js';

await createApp({
  name: 'clipboard-mcp-server',
  title: 'clipboard-mcp-server',
  instructions:
    'Use the clipboard_* tools to read, write, and inspect the local system clipboard (macOS; no API key). ' +
    'There is no history — the clipboard is a single live slot, so clipboard_read returns whatever is on it right now and clipboard_write replaces it. ' +
    'A clipboard holds one item in several formats (text/html/rtf/image); call clipboard_inspect first to see what is present, and prefer clipboard_read with format "auto". Images come back as base64 PNG.',
  tools: [clipboardInspect, clipboardRead, clipboardWrite],
  resources: [],
  prompts: [],
  async setup(core) {
    await initClipboardService(core.config, core.storage);
  },
});
