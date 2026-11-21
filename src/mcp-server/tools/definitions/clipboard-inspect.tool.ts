/**
 * @fileoverview clipboard_inspect tool — list clipboard types and sizes without reading content.
 * @module mcp-server/tools/definitions/clipboard-inspect.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { getClipboardService } from '@/services/clipboard/clipboard-service.js';
import { isClipboardOutcome, isInspectUnreadable } from '@/services/clipboard/types.js';

/**
 * True when a raw type name can sit in one Markdown table cell and read back as
 * written. A table cell holds one line, and CommonMark replaces NUL in any
 * inline content, so a name holding CR, LF, or NUL cannot. Neither can one
 * holding a backslash before `|`: escaped, it becomes `\\|`, which cmark-gfm
 * reads as one escaped pipe and micromark as a backslash and a cell break.
 */
function fitsTableCell(type: string): boolean {
  return !/[\r\n\0]|\\\|/.test(type);
}

/**
 * A one-line raw type name as one literal table cell. The application that
 * copied chose the name: a collision-safe code span keeps backticks and
 * emphasis literal, and every `|` is escaped, which GFM honors inside a span.
 */
function typeCell(type: string): string {
  return markdown().inlineCode(type).build().replaceAll('|', '\\|');
}

export const clipboardInspect = tool('clipboard_inspect', {
  title: 'Inspect Clipboard',
  description:
    'List the formats and byte sizes of what is currently on the clipboard without reading the full content. Use this before calling clipboard_read to see what formats are available and how large they are. Returns primaryFormat (the richest format present, using priority files > image > html > rtf > text), the list of all available semantic formats, itemCount (a macOS clipboard can hold several items, which clipboard_read reads one at a time with item), and every raw platform type identifier with its size.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({
    primaryFormat: z
      .enum(['text', 'html', 'rtf', 'image', 'files', 'empty'])
      .describe(
        'The richest format explicitly present on the clipboard (files > image > html > rtf > text). "empty" if the clipboard has no recognized content.',
      ),
    availableFormats: z
      .array(z.enum(['text', 'html', 'rtf', 'image', 'files']))
      .describe(
        'The semantic formats clipboard_read can return — a format is listed only when at least one of its representations was read. Two exceptions: an image whose bytes no decoder accepts, and on macOS a flat RTFD package that does not convert to RTF, are listed, but reading that format fails format_unavailable ("auto" moves on to the next format). On a clipboard holding several items the list covers every item, so one item can lack a listed format. Use to decide which format to pass to clipboard_read.',
      ),
    itemCount: z
      .number()
      .int()
      .describe(
        'Number of items on the clipboard. A macOS clipboard can hold several (images multi-selected in Photos, files copied in Finder), and clipboard_read reads one alone with item; Linux and Windows clipboards hold one. 0 when the clipboard is empty.',
      ),
    rawTypes: z
      .array(
        z
          .object({
            type: z
              .string()
              .describe(
                'UTI or pasteboard type identifier (e.g., "public.utf8-plain-text", "public.html").',
              ),
            bytes: z
              .number()
              .int()
              .optional()
              .describe(
                "Measured size of this representation in bytes; 0 means the representation is present and empty. On Linux, sizes are measured by streaming and counting each format's bytes without retaining them — may still add latency for large items, but never buffers the full payload. Absent when the platform did not size this type (a Linux type with no semantic format, such as TARGETS, or a Windows object that is not a string, byte array, stream, or file drop list) or when measurementFailed is true.",
              ),
            measurementFailed: z
              .boolean()
              .optional()
              .describe(
                'True when the platform listed this type but its data was nil, null, failed to read, or (a Windows text or RTF format) was not a string, or (a Windows file drop list) held no path a files read can list. Such an entry does not make its format available: clipboard_read cannot return it.',
              ),
          })
          .describe('A single pasteboard type entry with its identifier and byte size.'),
      )
      .describe(
        'Every type the platform lists, including translations it can supply, with byte sizes where measured. Useful for debugging or understanding exactly what was copied.',
      ),
  }),
  errors: [
    {
      reason: 'inspect_unreadable',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The platform clipboard helper returned output this server could not read.',
      recovery:
        'Retry clipboard_inspect once; if it fails again, copy the content afresh — the application holding the clipboard published metadata this server cannot decode.',
    },
    {
      reason: 'clipboard_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The platform clipboard helper is missing from PATH, or it cannot reach the desktop session (no display or compositor).',
      recovery:
        'Install the clipboard helper (Linux X11: apt install xclip; Wayland: apt install wl-clipboard; Windows: PowerShell 5.1+), or run the server inside the desktop session so DISPLAY or WAYLAND_DISPLAY names a live display, then retry.',
    },
  ],

  async handler(_input, ctx) {
    ctx.log.info('clipboard_inspect');
    const svc = getClipboardService();
    try {
      return await svc.inspect(ctx);
    } catch (err) {
      // A backend that could not read its own helper's output must not look
      // like an empty clipboard.
      if (isInspectUnreadable(err)) {
        throw ctx.fail('inspect_unreadable', err.message, {
          platform: err.platform,
          ...ctx.recoveryFor('inspect_unreadable'),
        });
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
    lines.push(`**Primary format:** ${result.primaryFormat}`);
    if (result.availableFormats.length > 0) {
      lines.push(`**Available formats:** ${result.availableFormats.join(', ')}`);
    } else {
      lines.push('**Available formats:** (none)');
    }
    lines.push(`**Item count:** ${result.itemCount}`);
    if (result.rawTypes.length === 0) {
      lines.push('\n**Raw types:** (empty clipboard)');
    } else if (result.rawTypes.every(({ type }) => fitsTableCell(type))) {
      lines.push('\n**Raw types:**');
      lines.push('| Type | Bytes |');
      lines.push('|:-----|------:|');
      for (const t of result.rawTypes) {
        const size = t.bytes === undefined ? 'unknown' : t.bytes.toLocaleString();
        const note = t.measurementFailed ? ' (measurementFailed: true)' : '';
        lines.push(`| ${typeCell(t.type)} | ${size}${note} |`);
      }
    } else {
      // A name no table cell can hold moves the whole section into a fenced
      // JSON block, which reads back exactly as structuredContent carries it.
      lines.push('\n**Raw types:**');
      lines.push(
        markdown()
          .codeBlock(JSON.stringify(result.rawTypes, null, 2), 'json')
          .build(),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
