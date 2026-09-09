/**
 * @fileoverview clipboard_read tool — read clipboard content in a specified format.
 * @module mcp-server/tools/definitions/clipboard-read.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { getClipboardService, isContentTooLarge } from '@/services/clipboard/clipboard-service.js';
import type { ByteRange, ClipboardFormat, RangedReadResult } from '@/services/clipboard/types.js';
import { FORMAT_PRIORITY } from '@/services/clipboard/types.js';

/** Auto-mode priority order: richest format wins (image > html > rtf > text). */
const AUTO_PRIORITY: ClipboardFormat[] = [...FORMAT_PRIORITY].reverse();

/**
 * Shape a backend read into tool output. Image bytes are additionally attached
 * to `content[]` as a real image block, so a client reading only `content[]`
 * receives the same payload a `structuredContent` client does.
 */
function toOutput(result: RangedReadResult, ctx: Pick<Context, 'content'>) {
  const content =
    result.format === 'image' ? result.content.toString('base64') : result.content.toString('utf8');
  if (result.format === 'image') ctx.content.image(content, 'image/png');
  return {
    format: result.format,
    content,
    ...(result.width !== undefined && { width: result.width }),
    ...(result.height !== undefined && { height: result.height }),
    byteSize: result.byteSize,
    totalByteSize: result.totalByteSize,
    complete: result.complete,
    ...(result.nextOffset !== undefined && { nextOffset: result.nextOffset }),
  };
}

export const clipboardRead = tool('clipboard_read', {
  title: 'Read Clipboard',
  description:
    'Read the current clipboard contents in a requested format. ' +
    '"auto" returns the richest format explicitly present (priority: image > html > rtf > text). ' +
    '"image" returns base64-encoded PNG, with pixel dimensions whenever the capture carries a readable PNG header. ' +
    '"html" returns raw HTML source. "rtf" returns raw RTF markup. "text" returns plain text. ' +
    'If the requested format is not present, returns a format_unavailable error — use "auto" when unsure, or call clipboard_inspect first. ' +
    'Content above the format size limit (512KB text/HTML/RTF, 5MB image) is retrieved in slices with offset/limit: ' +
    'omit both for the whole payload (errors with content_too_large if it exceeds the limit), or pass them to read a bounded window and ' +
    'continue from the returned nextOffset until complete is true.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    format: z
      .enum(['text', 'html', 'rtf', 'image', 'auto'])
      .default('auto')
      .describe(
        'Format to return. "auto" returns the richest format explicitly present on the clipboard ' +
          '(priority: image > html > rtf > text). "image" returns base64-encoded PNG data, with pixel dimensions ' +
          'whenever the capture carries a readable PNG header. ' +
          '"html" returns raw HTML source as copied from a browser. "rtf" returns raw RTF markup. ' +
          '"text" returns plain text. If the requested format is not on the clipboard, the tool returns an error. ' +
          'For "auto", offset/limit apply to the format auto resolves to.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Byte offset to start the returned slice at. Omit along with limit to read the whole payload ' +
          "(subject to the format size limit). When provided, pass the previous response's nextOffset to " +
          'continue a chunked read; an offset at or past the end of the content returns an empty slice with complete: true.',
      ),
    limit: z
      .number()
      .int()
      .min(4)
      .optional()
      .describe(
        'Maximum bytes to return in this slice, clamped to the format size limit (512KB text/HTML/RTF, 5MB image) — ' +
          'a single call never returns more than that regardless of the value passed. Minimum 4, so a text slice always ' +
          'holds at least one whole UTF-8 character and nextOffset always advances. Required alongside offset for a bounded read.',
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
      .describe(
        'Image width in pixels. Present on an "image" read whose dimensions could be determined.',
      ),
    height: z
      .number()
      .int()
      .optional()
      .describe(
        'Image height in pixels. Present on an "image" read whose dimensions could be determined.',
      ),
    byteSize: z.number().int().describe('Size of the content returned in this response, in bytes.'),
    totalByteSize: z
      .number()
      .int()
      .describe(
        'Total byte size of the full representation, regardless of how much this response returned.',
      ),
    complete: z
      .boolean()
      .describe(
        'True when this response reaches the end of the representation — nothing more to fetch.',
      ),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe(
        'Offset to pass as the next offset to continue the read. Absent once complete is true.',
      ),
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
      when: 'Clipboard content exceeds the size limit (512KB text/HTML/RTF, 5MB image) and no offset/limit was given.',
      recovery:
        'Retry with offset: 0 and a limit at or under the format size limit to read a bounded slice, then follow nextOffset ' +
        'until complete is true — or call clipboard_inspect and request a smaller format instead.',
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
    ctx.log.info('clipboard_read', {
      format: input.format,
      offset: input.offset,
      limit: input.limit,
    });
    const svc = getClipboardService();
    // Either field present signals an explicit ranged read; the service clamps
    // whatever limit reaches it to the format's size limit, so a caller who
    // only names one side can lean on that clamp rather than a tool-side default.
    const range: ByteRange | undefined =
      input.offset !== undefined || input.limit !== undefined
        ? { offset: input.offset ?? 0, limit: input.limit ?? Number.MAX_SAFE_INTEGER }
        : undefined;

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
        return toOutput(await svc.read(target, ctx, range), ctx);
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
      return toOutput(await svc.read(input.format, ctx, range), ctx);
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
    lines.push(
      `**Size:** ${result.byteSize.toLocaleString()} of ${result.totalByteSize.toLocaleString()} bytes`,
    );
    lines.push(`**Complete:** ${result.complete}`);
    if (result.nextOffset !== undefined) lines.push(`**Next offset:** ${result.nextOffset}`);

    // Render optional image dimensions when present (image format only)
    if (result.width !== undefined) lines.push(`**Width:** ${result.width} px`);
    if (result.height !== undefined) lines.push(`**Height:** ${result.height} px`);

    if (result.format === 'image') {
      // The bytes ride content[] as an image block instead of a base64 blob in text.
      lines.push('*(Image bytes attached as an image block; base64 in structuredContent.content)*');
    } else {
      lines.push('');
      // Fence the payload: clipboard bytes this tool did not author must not be
      // able to control how content[] renders. The fence outgrows any backtick
      // run in the payload, and the payload is emitted byte-for-byte.
      lines.push(markdown().codeBlock(result.content).build());
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
