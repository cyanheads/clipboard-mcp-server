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
  tools: [clipboardInspect, clipboardRead, clipboardWrite],
  resources: [],
  prompts: [],
  async setup(core) {
    await initClipboardService(core.config, core.storage);
  },
});
