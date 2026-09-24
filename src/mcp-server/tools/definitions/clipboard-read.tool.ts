/**
 * @fileoverview clipboard_read tool — read clipboard content in a specified format.
 * @module mcp-server/tools/definitions/clipboard-read.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { getClipboardService, isContentTooLarge } from '@/services/clipboard/clipboard-service.js';
import type { ByteRange, ClipboardFormat, RangedReadResult } from '@/services/clipboard/types.js';
import {
  FORMAT_PRIORITY,
  isClipboardOutcome,
  isInspectUnreadable,
} from '@/services/clipboard/types.js';

/** Auto-mode priority order: richest format wins (image > html > rtf > text). */
const AUTO_PRIORITY: ClipboardFormat[] = [...FORMAT_PRIORITY].reverse();

/** Formats to try in order; never empty. */
type Formats = readonly [ClipboardFormat, ...ClipboardFormat[]];

/**
 * True when a response holds the whole, non-empty representation — the only
 * image bytes that decode as a picture. Any other non-empty image response is
 * a PNG byte chunk.
 */
function isWholeImage(result: { byteSize: number; totalByteSize: number }): boolean {
  return result.byteSize > 0 && result.byteSize === result.totalByteSize;
}

/**
 * Shape a backend read into tool output. A whole image is additionally
 * attached to `content[]` as a real image block, so a client reading only
 * `content[]` receives the same picture a `structuredContent` client does; a
 * partial image slice travels as base64 text instead (see `format()`).
 */
function toOutput(result: RangedReadResult, ctx: Pick<Context, 'content'>) {
  const content =
    result.format === 'image' ? result.content.toString('base64') : result.content.toString('utf8');
  if (result.format === 'image' && isWholeImage(result)) {
    ctx.content.image(content, 'image/png');
  }
  return {
    format: result.format,
    content,
    ...(result.width !== undefined && { width: result.width }),
    ...(result.height !== undefined && { height: result.height }),
    byteSize: result.byteSize,
    totalByteSize: result.totalByteSize,
    complete: result.complete,
    ...(result.nextOffset !== undefined && { nextOffset: result.nextOffset }),
    representationId: result.representationId,
  };
}

export const clipboardRead = tool('clipboard_read', {
  title: 'Read Clipboard',
  description:
    'Read the current clipboard contents in a requested format. ' +
    '"auto" returns the richest format explicitly present (priority: image > html > rtf > text), moving on to the next one when a listed format cannot be read (an image no decoder accepts). ' +
    '"image" returns base64-encoded PNG, with pixel dimensions whenever the capture carries a readable PNG header. ' +
    '"html" returns raw HTML source. "rtf" returns raw RTF markup. "text" returns plain text. ' +
    'If the requested format is not present, returns a format_unavailable error — use "auto" when unsure, or call clipboard_inspect first. ' +
    'A text, HTML, RTF, or image format that is present but zero bytes long returns empty content, not an error (a zero-byte image attaches no image block). ' +
    'Content above the format size limit (512KB text/HTML/RTF, 5MB image) is retrieved in slices with offset/limit: ' +
    'omit both for the whole payload (errors with content_too_large if it exceeds the limit), or pass them to read a bounded window and ' +
    'continue from the returned nextOffset until complete is true, passing back the returned representationId with each continuation ' +
    'so a clipboard change between slices fails with representation_changed instead of mixing two values. ' +
    'Image slices are PNG byte chunks, not standalone images: only a response holding the whole image attaches an image block; ' +
    'a partial slice carries its base64 in the text, and the chunks are base64-decoded separately and their bytes concatenated in offset order.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    format: z
      .enum(['text', 'html', 'rtf', 'image', 'auto'])
      .default('auto')
      .describe(
        'Format to return. "auto" returns the richest format explicitly present on the clipboard ' +
          '(priority: image > html > rtf > text), moving on to the next one when a listed format cannot be read. "image" returns base64-encoded PNG data, with pixel dimensions ' +
          'whenever the capture carries a readable PNG header. ' +
          '"html" returns raw HTML source as copied from a browser. "rtf" returns raw RTF markup. ' +
          '"text" returns plain text. If the requested format is not on the clipboard, the tool returns a format_unavailable error. ' +
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
          'holds at least one whole UTF-8 character and nextOffset always advances. ' +
          'Optional in a ranged read: passing offset without limit returns up to the format size limit from that offset.',
      ),
    representationId: z
      .string()
      .optional()
      .describe(
        "The previous slice's representationId, passed when continuing a chunked read from its nextOffset. " +
          'If the clipboard value being read now has a different representationId — another application copied since, ' +
          'or "auto" now resolves to a different format — the call returns no bytes and fails with representation_changed. ' +
          'Omit on the first read.',
      ),
  }),
  output: z.object({
    format: z
      .enum(['text', 'html', 'rtf', 'image'])
      .describe('The format actually returned (relevant when input was "auto").'),
    content: z
      .string()
      .describe(
        'Clipboard contents. For "image", base64-encoded PNG data; a partial image slice is PNG byte chunks, not a standalone image — ' +
          'base64-decode each slice separately and concatenate the bytes in offset order.',
      ),
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
    representationId: z
      .string()
      .describe(
        'Opaque token for the clipboard value, including its format, this response was cut from. ' +
          'Equal across full and sliced reads of an unchanged value; pass it back as representationId ' +
          'with each nextOffset so a clipboard change between slices fails instead of mixing two values.',
      ),
  }),
  errors: [
    {
      reason: 'format_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'Requested format is not present on the clipboard, or the clipboard is empty.',
      recovery:
        'Call clipboard_inspect to see available formats, then retry with a supported format or use "auto".',
    },
    {
      reason: 'clipboard_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The platform clipboard helper is missing from PATH, or it cannot reach the desktop session (no display or compositor).',
      recovery:
        'Install the clipboard helper (Linux X11: apt install xclip; Wayland: apt install wl-clipboard; Windows: PowerShell 5.1+), or run the server inside the desktop session so DISPLAY or WAYLAND_DISPLAY names a live display, then retry.',
    },
    {
      reason: 'content_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Clipboard content exceeds the size limit (512KB text/HTML/RTF, 5MB image) and no offset/limit was given.',
      recovery:
        'Retry with offset: 0 and a limit at or under the format size limit to read a bounded slice, then follow nextOffset ' +
        'until complete is true — or call clipboard_inspect and request a smaller format instead. ' +
        'Image slices are PNG byte chunks, not standalone images: base64-decode each one and concatenate the bytes in offset order.',
    },
    {
      reason: 'representation_changed',
      code: JsonRpcErrorCode.Conflict,
      when:
        'representationId was passed and the clipboard value being read now has a different one (another application copied, ' +
        'or "auto" resolved to a different format), or the clipboard changed while this read was in progress.',
      recovery:
        'The clipboard changed during the read — after an earlier slice, or while this call was reading. Discard the bytes read so far and restart at offset 0 without representationId.',
    },
    {
      reason: 'inspect_unreadable',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Format "auto" inspects the clipboard first, and the platform clipboard helper returned a type listing this server could not read.',
      recovery:
        'Retry clipboard_read with an explicit format (text, html, rtf, or image), which reads without that inspection; ' +
        'if it fails too, copy the content afresh — the application holding the clipboard published metadata this server cannot decode.',
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

    // The format being read — for "auto", each listed format in turn.
    let format: ClipboardFormat | 'auto' = input.format;

    /** For "auto": the formats inspection lists, richest first. */
    const listedFormats = async (): Promise<Formats> => {
      const inspection = await svc.inspect(ctx);
      const [richest, ...others] = AUTO_PRIORITY.filter((f) =>
        inspection.availableFormats.includes(f),
      );
      if (!richest) {
        throw ctx.fail(
          'format_unavailable',
          inspection.rawTypes.length === 0
            ? 'Clipboard is empty — no recognized format present.'
            : 'Clipboard has no recognized semantic format.',
          { ...ctx.recoveryFor('format_unavailable') },
        );
      }
      return [richest, ...others];
    };

    /**
     * Read the first of `formats` that is present. A listed format can still
     * read as absent (an image no decoder accepts), so only that outcome moves
     * on to the next format; any other failure, or the last format's, propagates.
     */
    const readFirstPresent = async ([first, ...rest]: Formats): Promise<RangedReadResult> => {
      format = first;
      try {
        return await svc.read(first, ctx, range);
      } catch (err) {
        const [next, ...after] = rest;
        if (next && isClipboardOutcome(err) && err.category === 'format_unavailable') {
          return await readFirstPresent([next, ...after]);
        }
        throw err;
      }
    };

    try {
      const result = await readFirstPresent(
        input.format === 'auto' ? await listedFormats() : [input.format],
      );
      // Compared before any bytes or image block leave the handler.
      if (input.representationId && result.representationId !== input.representationId) {
        throw ctx.fail(
          'representation_changed',
          `The clipboard's ${format} value no longer matches the given representationId.`,
          { requestedFormat: format, ...ctx.recoveryFor('representation_changed') },
        );
      }
      return toOutput(result, ctx);
    } catch (err) {
      // The sentinel's message carries a preview of the helper output; the
      // data carries only the platform, never that output.
      if (isInspectUnreadable(err)) {
        throw ctx.fail('inspect_unreadable', err.message, {
          platform: err.platform,
          ...ctx.recoveryFor('inspect_unreadable'),
        });
      }
      if (isContentTooLarge(err)) {
        throw ctx.fail(
          'content_too_large',
          `Clipboard content is ${err.bytes} bytes, limit is ${err.limit} bytes.`,
          {
            bytes: err.bytes,
            limit: err.limit,
            format,
            ...ctx.recoveryFor('content_too_large'),
          },
        );
      }
      if (isClipboardOutcome(err)) {
        if (err.category === 'clipboard_unavailable') {
          throw ctx.fail('clipboard_unavailable', err.message, {
            platform: err.platform,
            recovery: { hint: err.recoveryHint },
          });
        }
        if (err.category === 'representation_changed') {
          throw ctx.fail('representation_changed', err.message, {
            platform: err.platform,
            ...ctx.recoveryFor('representation_changed'),
          });
        }
        throw ctx.fail(
          'format_unavailable',
          err.category === 'empty'
            ? 'Clipboard is empty — no recognized format present.'
            : `Format "${format}" is not present on the clipboard.`,
          { requestedFormat: format, ...ctx.recoveryFor('format_unavailable') },
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
    lines.push(`**Representation ID:** ${result.representationId}`);

    // Render optional image dimensions when present (image format only)
    if (result.width !== undefined) lines.push(`**Width:** ${result.width} px`);
    if (result.height !== undefined) lines.push(`**Height:** ${result.height} px`);

    if (result.format === 'image' && result.byteSize === 0) {
      lines.push('*(No image bytes in this response — nothing is attached.)*');
    } else if (result.format === 'image' && isWholeImage(result)) {
      // The picture rides content[] as an image block instead of a base64 blob in text.
      lines.push('*(Image bytes attached as an image block; base64 in structuredContent.content)*');
    } else {
      if (result.format === 'image') {
        // A partial slice is not a decodable image, so its base64 goes in the text.
        // Image slices are never UTF-8 trimmed: the slice ends where the next begins.
        const end = result.nextOffset ?? result.totalByteSize;
        lines.push(
          `**Byte range:** bytes ${end - result.byteSize} through ${end - 1}`,
          '*(PNG byte chunk, not a standalone image. Base64-decode each chunk separately and ' +
            'concatenate the bytes in offset order to rebuild the PNG.)*',
        );
      }
      lines.push('');
      // Fence the payload: clipboard bytes this tool did not author must not be
      // able to control how content[] renders. The fence outgrows any backtick
      // run in the payload, and the payload is emitted byte-for-byte.
      lines.push(markdown().codeBlock(result.content).build());
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
