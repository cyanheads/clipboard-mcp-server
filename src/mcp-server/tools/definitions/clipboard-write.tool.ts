/**
 * @fileoverview clipboard_write tool — write content to the clipboard.
 * @module mcp-server/tools/definitions/clipboard-write.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { getClipboardService, isContentTooLarge } from '@/services/clipboard/clipboard-service.js';
import { isClipboardOutcome } from '@/services/clipboard/types.js';

/** Whether the caller supplied content worth writing. */
function hasContent<T extends { content?: string | undefined }>(
  input: T,
): input is T & { content: string } {
  return input.content !== undefined && input.content !== '';
}

export const clipboardWrite = tool('clipboard_write', {
  title: 'Write Clipboard',
  description: `Write content to the clipboard, replacing the current contents, or clear the clipboard outright. "text" writes plain text. "html" writes HTML; on macOS and Windows it also publishes an auto-generated, tag-stripped plain-text fallback. On Linux the HTML itself is the only payload, with no stripped fallback: Wayland offers it as text/html and under the plain-text types, and X11 advertises only text/html but answers a request for a plain-text type such as UTF8_STRING with the same markup, so a plain-text paste can receive raw HTML. Pass clear: true with no content to remove every representation, leaving clipboard_inspect reporting an empty clipboard; supply exactly one of content or clear: true.`,
  annotations: { destructiveHint: true, openWorldHint: false },
  input: z
    .object({
      content: z
        .string()
        .optional()
        .describe(
          'Content to write to the clipboard. Required unless clear: true, which takes no content.',
        ),
      format: z
        .enum(['text', 'html'])
        .default('text')
        .describe(
          `Format of the content. "text" writes plain text. "html" writes HTML; on macOS and Windows it also publishes an auto-generated, tag-stripped plain-text fallback. On Linux there is no stripped fallback: Wayland also offers the markup under the plain-text types, and X11 hands the same markup to a plain-text request. Ignored when clear is true.`,
        ),
      clear: z
        .boolean()
        .default(false)
        .describe(
          'Set true to clear the clipboard instead of writing: every representation is removed and clipboard_inspect then reports an empty clipboard. Cannot be combined with content.',
        ),
    })
    .refine((input) => hasContent(input) || input.clear, {
      message:
        'Provide content to write, or pass clear: true to empty the clipboard. An empty content string writes nothing and is rejected.',
      path: ['content'],
    })
    .refine((input) => !(hasContent(input) && input.clear), {
      message: 'Pass either content or clear: true, not both — clear writes no content.',
      path: ['clear'],
    }),
  output: z.object({
    format: z
      .enum(['text', 'html'])
      .optional()
      .describe('Format written. Absent when this call cleared the clipboard.'),
    byteSize: z
      .number()
      .int()
      .describe('Byte size of the written content. Zero when the clipboard was cleared.'),
    cleared: z
      .boolean()
      .optional()
      .describe('True when this call cleared the clipboard instead of writing content.'),
    previousContent: z
      .string()
      .optional()
      .describe(
        'Plain-text content that was on the clipboard before this write or clear, if any and within size limits. ' +
          'Write it back with clipboard_write to undo an unintended overwrite. Absent if the clipboard was ' +
          'empty, held no text representation, or the prior content exceeded the read size limit.',
      ),
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
      when: 'The platform clipboard helper is missing from PATH, or it cannot reach the desktop session (no display or compositor).',
      recovery:
        'Install the clipboard helper (Linux X11: apt install xclip, plus xsel for clear; Wayland: apt install wl-clipboard; Windows: PowerShell 5.1+), or run the server inside the desktop session so DISPLAY or WAYLAND_DISPLAY names a live display, then retry.',
    },
  ],

  async handler(input, ctx) {
    const svc = getClipboardService();

    try {
      if (input.clear) {
        ctx.log.info('clipboard_write', { clear: true });
        return await svc.clear(ctx);
      }
      // The input schema rejects this pair; a caller invoking the handler
      // directly still must not reach the backend with nothing to write.
      if (!hasContent(input)) {
        throw validationError(
          'clipboard_write needs content to write, or clear: true to empty the clipboard.',
        );
      }
      ctx.log.info('clipboard_write', {
        format: input.format,
        bytes: Buffer.byteLength(input.content, 'utf8'),
      });
      return await svc.write(input.content, input.format, ctx);
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
      if (isClipboardOutcome(err) && err.category === 'clipboard_unavailable') {
        throw ctx.fail('clipboard_unavailable', err.message, {
          platform: err.platform,
          recovery: { hint: err.recoveryHint },
        });
      }
      throw err;
    }
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.cleared === true) {
      lines.push('**Cleared:** true — every clipboard representation was removed.');
    }
    lines.push(`**Format written:** ${result.format ?? 'none'}`);
    lines.push(`**Byte size:** ${result.byteSize.toLocaleString()} bytes`);
    if (result.previousContent !== undefined) {
      lines.push('');
      lines.push('**Previous content:**');
      // Fence the payload: prior clipboard bytes this tool did not author must
      // not be able to control how content[] renders.
      lines.push(markdown().codeBlock(result.previousContent).build());
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
