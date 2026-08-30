/**
 * @fileoverview clipboard_write tool — write content to the clipboard.
 * @module mcp-server/tools/definitions/clipboard-write.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClipboardService, isContentTooLarge } from '@/services/clipboard/clipboard-service.js';

export const clipboardWrite = tool('clipboard_write', {
  title: 'Write Clipboard',
  description: `Write content to the clipboard, replacing the current contents. "text" writes plain text. "html" writes HTML; on macOS and Windows it also publishes an auto-generated, tag-stripped plain-text fallback. Linux X11 and Wayland publish only text/html.`,
  annotations: { destructiveHint: true, openWorldHint: false },
  input: z.object({
    content: z.string().describe('Content to write to the clipboard.'),
    format: z
      .enum(['text', 'html'])
      .default('text')
      .describe(
        `Format of the content. "text" writes plain text. "html" writes HTML; on macOS and Windows it also publishes an auto-generated, tag-stripped plain-text fallback. Linux X11 and Wayland publish only text/html.`,
      ),
  }),
  output: z.object({
    format: z.enum(['text', 'html']).describe('Format written.'),
    byteSize: z.number().int().describe('Byte size of the written content.'),
  }),
  errors: [
    {
      reason: 'content_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Write content exceeds the 1MB size limit.',
      recovery:
        'Content is too large to write to the clipboard. Truncate or summarize before writing.',
    },
    {
      reason: 'clipboard_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Required clipboard tool not found on this platform.',
      recovery:
        'Install the platform clipboard tool: macOS (built-in), Linux X11 (apt install xclip), Linux Wayland (apt install wl-clipboard), Windows (PowerShell 5.1+).',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('clipboard_write', {
      format: input.format,
      bytes: Buffer.byteLength(input.content, 'utf8'),
    });
    const svc = getClipboardService();
    try {
      const result = await svc.write(input.content, input.format, ctx);
      return result;
    } catch (err) {
      if (isContentTooLarge(err)) {
        throw ctx.fail(
          'content_too_large',
          `Content is ${err.bytes} bytes, limit is ${err.limit} bytes.`,
          {
            bytes: err.bytes,
            limit: err.limit,
            ...ctx.recoveryFor('content_too_large'),
          },
        );
      }
      throw err;
    }
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Format written:** ${result.format}`);
    lines.push(`**Byte size:** ${result.byteSize.toLocaleString()} bytes`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
