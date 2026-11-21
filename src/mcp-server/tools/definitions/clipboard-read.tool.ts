/**
 * @fileoverview clipboard_read tool — read clipboard content in a specified format.
 * @module mcp-server/tools/definitions/clipboard-read.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { getClipboardService, isContentTooLarge } from '@/services/clipboard/clipboard-service.js';
import type { ByteRange, ClipboardFormat } from '@/services/clipboard/types.js';
import {
  FORMAT_PRIORITY,
  isClipboardOutcome,
  isInspectUnreadable,
} from '@/services/clipboard/types.js';

/** Auto-mode priority order: richest format wins (files > image > html > rtf > text). */
const AUTO_PRIORITY: ClipboardFormat[] = [...FORMAT_PRIORITY].reverse();

/** Formats to try in order; never empty. */
type Formats = readonly [ClipboardFormat, ...ClipboardFormat[]];

/** One `ClipboardService.read()` result. */
type ServiceRead = Awaited<ReturnType<ReturnType<typeof getClipboardService>['read']>>;

/**
 * Which items a read with no `item` draws on when the clipboard holds several,
 * per format. An image comes from the first item holding a PNG, else the first
 * holding TIFF or PICT, so not always the first item holding an image; RTF is
 * the one document AppKit builds from every item it can render as RTF.
 */
const WHOLE_CLIPBOARD_SOURCE: Record<ClipboardFormat, string> = {
  text: 'joins the text of every item that has it into one value',
  rtf: 'is one RTF document built from every item that holds text, HTML, or RTF',
  html: 'comes from the first item that has the format',
  image: 'comes from one item: the first holding a PNG, else the first holding another image type',
  files: "lists every item's paths, in item order",
};

/**
 * The agent-facing notice for a read: which items a read with no `item` drew
 * on when the clipboard holds several, and how many paths a `files` read left
 * out. Undefined when neither applies.
 */
function readNotice(result: ServiceRead): string | undefined {
  const notes: string[] = [];
  const { format, itemCount, itemScope, omittedPaths } = result;
  if (itemScope !== undefined) {
    notes.push(
      `The clipboard holds ${itemCount} items; this "${format}" read ${WHOLE_CLIPBOARD_SOURCE[format]}. Pass item (0 to ${itemCount - 1}) to read one item alone.`,
    );
  }
  if (omittedPaths !== undefined) {
    notes.push(
      omittedPaths === 1
        ? '1 copied path contains a line break or bytes that are not UTF-8, which one-path-per-line UTF-8 content cannot hold, so it is left out.'
        : `${omittedPaths} copied paths contain a line break or bytes that are not UTF-8, which one-path-per-line UTF-8 content cannot hold, so they are left out.`,
    );
  }
  return notes.length > 0 ? notes.join(' ') : undefined;
}

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
function toOutput(result: ServiceRead, ctx: Pick<Context, 'content'>) {
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
    itemCount: result.itemCount,
  };
}

export const clipboardRead = tool('clipboard_read', {
  title: 'Read Clipboard',
  description:
    'Read the current clipboard contents in a requested format. "auto" returns the richest format explicitly present (priority: files > image > html > rtf > text), moving on to the next one when a listed format cannot be read (an image no decoder accepts, or a macOS RTFD package that does not convert to RTF). "files" returns the absolute paths of files copied in a file manager, one per line — paths on the machine this server runs on, which the server never opens or reads. "image" returns base64-encoded PNG, with pixel dimensions whenever the capture carries a readable PNG header. "html" returns raw HTML source. "rtf" returns raw RTF markup. "text" returns plain text. If the requested format is not present, returns a format_unavailable error — use "auto" when unsure, or call clipboard_inspect first. A macOS clipboard can hold several items (itemCount): pass item to read one alone; without it, a read of several items says in its notice which items it drew on. A text, HTML, RTF, or image format that is present but zero bytes long returns empty content, not an error (a zero-byte image attaches no image block). Content above the format size limit (512KB text/HTML/RTF/files, 5MB image) is retrieved in slices with offset/limit: omit both for the whole payload (errors with content_too_large if it exceeds the limit), or pass them to read a bounded window and continue from the returned nextOffset until complete is true, passing back the returned representationId (and the same item) with each continuation so a clipboard change between slices fails with representation_changed instead of mixing two values. Image slices are PNG byte chunks, not standalone images: only a response holding the whole image attaches an image block; a partial slice carries its base64 in the text, and the chunks are base64-decoded separately and their bytes concatenated in offset order.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    format: z
      .enum(['text', 'html', 'rtf', 'image', 'files', 'auto'])
      .default('auto')
      .describe(
        'Format to return. "auto" returns the richest format explicitly present on the clipboard (priority: files > image > html > rtf > text), moving on to the next one when a listed format cannot be read. "files" returns the absolute paths of copied files, one per line — paths on the machine this server runs on, which the server never opens. "image" returns base64-encoded PNG data, with pixel dimensions whenever the capture carries a readable PNG header. "html" returns raw HTML source as copied from a browser. "rtf" returns raw RTF markup. "text" returns plain text. If the requested format is not on the clipboard, the tool returns a format_unavailable error. For "auto", offset/limit apply to the format auto resolves to.',
      ),
    item: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        '0-based index of one clipboard item to read alone; every format, "auto" included, then reads that item only. A macOS clipboard can hold several items (images multi-selected in Photos, files copied in Finder), counted by itemCount. Omit to read the clipboard as a whole: of several items, "text" then joins every item\'s text, "rtf" is one RTF document built from every item holding text, HTML, or RTF, "html" comes from the first item that has it, "image" from the first item holding a PNG (else the first holding another image type), and "files" lists every item\'s paths; the notice says which. Linux and Windows clipboards hold one item, so only item 0 reads there. An item at or past itemCount fails format_unavailable. Pass the same item with every continuation of a chunked read.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Byte offset to start the returned slice at. Omit along with limit to read the whole payload (subject to the format size limit). When provided, pass the previous response's nextOffset to continue a chunked read; an offset at or past the end of the content returns an empty slice with complete: true.",
      ),
    limit: z
      .number()
      .int()
      .min(4)
      .optional()
      .describe(
        'Maximum bytes to return in this slice, clamped to the format size limit (512KB text/HTML/RTF/files, 5MB image) — a single call never returns more than that regardless of the value passed. Minimum 4, so a text slice always holds at least one whole UTF-8 character and nextOffset always advances. Optional in a ranged read: passing offset without limit returns up to the format size limit from that offset.',
      ),
    representationId: z
      .string()
      .optional()
      .describe(
        'The previous slice\'s representationId, passed when continuing a chunked read from its nextOffset, with the same item as that read (or none, if it passed none). If the clipboard value being read now has a different representationId — another application copied since, "auto" now resolves to a different format, or item differs from the earlier read — the call returns no bytes and fails with representation_changed. Omit on the first read.',
      ),
  }),
  output: z.object({
    format: z
      .enum(['text', 'html', 'rtf', 'image', 'files'])
      .describe('The format actually returned (relevant when input was "auto").'),
    content: z
      .string()
      .describe(
        'Clipboard contents. For "files", absolute paths on the machine this server runs on, one per line. For "image", base64-encoded PNG data; a partial image slice is PNG byte chunks, not a standalone image — base64-decode each slice separately and concatenate the bytes in offset order.',
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
        'Opaque token for the clipboard value, including its format and item, this response was cut from. Equal across full and sliced reads of an unchanged value; pass it back as representationId, with the same item, with each nextOffset so a clipboard change between slices fails instead of mixing two values.',
      ),
    itemCount: z
      .number()
      .int()
      .describe(
        'Number of items on the clipboard: several are possible on macOS, while Linux and Windows clipboards hold one. When it is more than one and no item was passed, the notice says which items this read drew on.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a read with no item drew on a clipboard holding several items (which items it read, and how to read one alone), or when a "files" read left paths out (how many, and why).',
      ),
  },
  errors: [
    {
      reason: 'format_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'Requested format is not present on the clipboard (or on the requested item), item is at or past the last clipboard item, or the clipboard is empty.',
      recovery:
        'Call clipboard_inspect to see available formats and itemCount, then retry with a supported format, "auto", or an item below itemCount.',
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
      when: 'Clipboard content exceeds the size limit (512KB text/HTML/RTF/files, 5MB image) and no offset/limit was given.',
      recovery:
        'Retry with offset: 0 and a limit at or under the format size limit to read a bounded slice, then follow nextOffset until complete is true — or call clipboard_inspect and request a smaller format instead. Image slices are PNG byte chunks, not standalone images: base64-decode each one and concatenate the bytes in offset order.',
    },
    {
      reason: 'representation_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'representationId was passed and the clipboard value being read now has a different one (another application copied, "auto" resolved to a different format, or item differs from the earlier read), or the clipboard changed while this read was in progress.',
      recovery:
        'The value being read is not the one the earlier slices came from: another application copied after an earlier slice or during this call, or this continuation named a different format or item. Discard the bytes read so far and restart at offset 0 without representationId, passing the same item on every slice.',
    },
    {
      reason: 'inspect_unreadable',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Format "auto" inspects the clipboard first, and the platform clipboard helper returned a type listing this server could not read.',
      recovery:
        'Retry clipboard_read with an explicit format (text, html, rtf, image, or files), which reads without that inspection; if it fails too, copy the content afresh — the application holding the clipboard published metadata this server cannot decode.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('clipboard_read', {
      format: input.format,
      item: input.item,
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

    /**
     * For "auto": the formats inspection lists, richest first. The listing
     * covers every item, so an item past the last fails here, before any read.
     */
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
      const { itemCount } = inspection;
      if (input.item !== undefined && input.item >= itemCount) {
        throw ctx.fail(
          'format_unavailable',
          `The clipboard holds ${itemCount} ${itemCount === 1 ? 'item' : 'items'}; item ${input.item} is past the last (${itemCount - 1}).`,
          { item: input.item, itemCount, ...ctx.recoveryFor('format_unavailable') },
        );
      }
      return [richest, ...others];
    };

    /**
     * Read the first of `formats` that is present. A listed format can still
     * read as absent (an image no decoder accepts, or an item without it), so
     * only that outcome moves on to the next format; any other failure, or the
     * last format's, propagates.
     */
    const readFirstPresent = async ([first, ...rest]: Formats): Promise<ServiceRead> => {
      format = first;
      try {
        return await svc.read(first, ctx, range, input.item);
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
      const notice = readNotice(result);
      if (notice !== undefined) ctx.enrich.notice(notice);
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
            : input.item === undefined
              ? `Format "${format}" is not present on the clipboard.`
              : `Format "${format}" is not present on clipboard item ${input.item}, or the clipboard has no item ${input.item}.`,
          {
            requestedFormat: format,
            ...(input.item !== undefined && { item: input.item }),
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
    lines.push(`**Representation ID:** ${result.representationId}`);
    lines.push(`**Item count:** ${result.itemCount}`);

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
          '*(PNG byte chunk, not a standalone image. Base64-decode each chunk separately and concatenate the bytes in offset order to rebuild the PNG.)*',
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
