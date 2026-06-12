/**
 * @fileoverview clipboard_read tool — read clipboard content in a specified format.
 * @module mcp-server/tools/definitions/clipboard-read.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClipboardService, isContentTooLarge } from '@/services/clipboard/clipboard-service.js';
import type { ClipboardFormat } from '@/services/clipboard/types.js';
import { FORMAT_PRIORITY } from '@/services/clipboard/types.js';

/** Auto-mode priority order: richest format wins (image > html > rtf > text). */
const AUTO_PRIORITY: ClipboardFormat[] = [...FORMAT_PRIORITY].reverse();

export const clipboardRead = tool('clipboard_read', {
  title: 'Read Clipboard',
  description:
    'Read the current clipboard contents in a requested format. ' +
    '"auto" returns the richest format explicitly present (priority: image > html > rtf > text). ' +
    '"image" returns base64-encoded PNG with dimensions. ' +
    '"html" returns raw HTML source. "rtf" returns raw RTF markup. "text" returns plain text. ' +
    'If the requested format is not present, returns a format_unavailable error — use "auto" when unsure, or call clipboard_inspect first.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    format: z
      .enum(['text', 'html', 'rtf', 'image', 'auto'])
      .default('auto')
      .describe(
        'Format to return. "auto" returns the richest format explicitly present on the clipboard ' +
          '(priority: image > html > rtf > text). "image" returns base64-encoded PNG data with dimensions. ' +
          '"html" returns raw HTML source as copied from a browser. "rtf" returns raw RTF markup. ' +
          '"text" returns plain text. If the requested format is not on the clipboard, the tool returns an error.',
      ),
  }),
  output: z.object({
    format: z
      .enum(['text', 'html', 'rtf', 'image'])
      .describe('The format actually returned (relevant when input was "auto").'),
    content: z.string().describe('Clipboard contents. For "image", base64-encoded PNG data.'),
    width: z
      .number()
      .int()
      .optional()
      .describe('Image width in pixels. Present only when format is "image".'),
    height: z
      .number()
      .int()
      .optional()
      .describe('Image height in pixels. Present only when format is "image".'),
    byteSize: z.number().int().describe('Size of the content in bytes.'),
  }),
  errors: [
    {
      reason: 'format_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'Requested format is not present on the clipboard.',
      recovery:
        'Call clipboard_inspect to see available formats, then retry with a supported format or use "auto".',
    },
    {
      reason: 'content_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Clipboard content exceeds the size limit (512KB text/HTML/RTF, 5MB image).',
      recovery:
        'Content is too large to return. Call clipboard_inspect to see available formats and sizes, then decide whether to request a smaller format.',
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
    ctx.log.info('clipboard_read', { format: input.format });
    const svc = getClipboardService();

    if (input.format === 'auto') {
      // Inspect to find the richest available format, then read it.
      const inspection = await svc.inspect(ctx);
      if (inspection.primaryFormat === 'empty') {
        throw ctx.fail('format_unavailable', 'Clipboard is empty — no recognized format present.', {
          ...ctx.recoveryFor('format_unavailable'),
        });
      }
      // Find the richest format in priority order
      const target = AUTO_PRIORITY.find((f) => inspection.availableFormats.includes(f));
      if (!target) {
        throw ctx.fail('format_unavailable', 'Clipboard has no recognized semantic format.', {
          ...ctx.recoveryFor('format_unavailable'),
        });
      }
      try {
        const result = await svc.read(target, ctx);
        const content =
          result.format === 'image'
            ? result.content.toString('base64')
            : result.content.toString('utf8');
        return {
          format: result.format,
          content,
          ...(result.width !== undefined && { width: result.width }),
          ...(result.height !== undefined && { height: result.height }),
          byteSize: result.content.byteLength,
        };
      } catch (err) {
        if (isContentTooLarge(err)) {
          throw ctx.fail(
            'content_too_large',
            `Clipboard content is ${err.bytes} bytes, limit is ${err.limit} bytes.`,
            {
              bytes: err.bytes,
              limit: err.limit,
              format: target,
              ...ctx.recoveryFor('content_too_large'),
            },
          );
        }
        throw err;
      }
    }

    // Explicit format request
    try {
      const result = await svc.read(input.format, ctx);
      const content =
        result.format === 'image'
          ? result.content.toString('base64')
          : result.content.toString('utf8');
      return {
        format: result.format,
        content,
        ...(result.width !== undefined && { width: result.width }),
        ...(result.height !== undefined && { height: result.height }),
        byteSize: result.content.byteLength,
      };
    } catch (err) {
      if (isContentTooLarge(err)) {
        throw ctx.fail(
          'content_too_large',
          `Clipboard content is ${err.bytes} bytes, limit is ${err.limit} bytes.`,
          {
            bytes: err.bytes,
            limit: err.limit,
            format: input.format,
            ...ctx.recoveryFor('content_too_large'),
          },
        );
      }
      // Map "not found" message from backend to format_unavailable contract entry
      if (err instanceof Error && err.message.toLowerCase().includes('not found')) {
        throw ctx.fail(
          'format_unavailable',
          `Format "${input.format}" is not present on the clipboard.`,
          {
            requestedFormat: input.format,
            ...ctx.recoveryFor('format_unavailable'),
          },
        );
      }
      throw err;
    }
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Format:** ${result.format}`);
    lines.push(`**Size:** ${result.byteSize.toLocaleString()} bytes`);

    // Render optional image dimensions when present (image format only)
    if (result.width !== undefined) lines.push(`**Width:** ${result.width} px`);
    if (result.height !== undefined) lines.push(`**Height:** ${result.height} px`);

    if (result.format === 'image') {
      // Don't dump base64 blob into content[] — render metadata only; base64 data is in structuredContent
      lines.push('*(Image data available in structuredContent.content)*');
    } else {
      lines.push('');
      lines.push(result.content);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
