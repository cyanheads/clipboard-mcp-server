/**
 * @fileoverview Tests for clipboard_inspect tool.
 * @module tests/tools/clipboard-inspect.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboardInspect } from '@/mcp-server/tools/definitions/clipboard-inspect.tool.js';
import { clipboardOutcome, inspectUnreadable } from '@/services/clipboard/types.js';

// Mock the clipboard service module
vi.mock('@/services/clipboard/clipboard-service.js', () => ({
  getClipboardService: vi.fn(),
  initClipboardService: vi.fn(),
}));

import { getClipboardService } from '@/services/clipboard/clipboard-service.js';

const mockGetService = vi.mocked(getClipboardService);

describe('clipboardInspect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns inspect result with primaryFormat and availableFormats', async () => {
    const mockInspect = vi.fn().mockResolvedValueOnce({
      primaryFormat: 'text' as const,
      availableFormats: ['text' as const],
      rawTypes: [{ type: 'public.utf8-plain-text', bytes: 12 }],
    });
    mockGetService.mockReturnValueOnce({ inspect: mockInspect } as ReturnType<
      typeof getClipboardService
    >);

    const ctx = createMockContext({ errors: clipboardInspect.errors });
    const input = clipboardInspect.input.parse({});
    const result = await clipboardInspect.handler(input, ctx);
    expect(result.primaryFormat).toBe('text');
    expect(result.availableFormats).toEqual(['text']);
    expect(result.rawTypes).toHaveLength(1);
  });

  it('returns empty state when clipboard is empty', async () => {
    const mockInspect = vi.fn().mockResolvedValueOnce({
      primaryFormat: 'empty' as const,
      availableFormats: [],
      rawTypes: [],
    });
    mockGetService.mockReturnValueOnce({ inspect: mockInspect } as ReturnType<
      typeof getClipboardService
    >);

    const ctx = createMockContext({ errors: clipboardInspect.errors });
    const input = clipboardInspect.input.parse({});
    const result = await clipboardInspect.handler(input, ctx);
    expect(result.primaryFormat).toBe('empty');
    expect(result.availableFormats).toEqual([]);
  });

  it('returns multiple formats when html + text + image are all present', async () => {
    const mockInspect = vi.fn().mockResolvedValueOnce({
      primaryFormat: 'image' as const,
      availableFormats: ['text' as const, 'html' as const, 'image' as const],
      rawTypes: [
        { type: 'public.utf8-plain-text', bytes: 10 },
        { type: 'public.html', bytes: 200 },
        { type: 'public.png', bytes: 51200 },
      ],
    });
    mockGetService.mockReturnValueOnce({ inspect: mockInspect } as ReturnType<
      typeof getClipboardService
    >);

    const ctx = createMockContext({ errors: clipboardInspect.errors });
    const input = clipboardInspect.input.parse({});
    const result = await clipboardInspect.handler(input, ctx);
    expect(result.primaryFormat).toBe('image');
    expect(result.availableFormats).toContain('html');
    expect(result.rawTypes).toHaveLength(3);
  });

  it('formats output with primaryFormat, availableFormats, and rawTypes table', () => {
    const output = {
      primaryFormat: 'html' as const,
      availableFormats: ['text' as const, 'html' as const],
      itemCount: 1,
      rawTypes: [
        { type: 'public.utf8-plain-text', bytes: 15 },
        { type: 'public.html', bytes: 350 },
      ],
    };
    const blocks = clipboardInspect.format!(output);
    const text = blocks.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('html');
    expect(text).toContain('public.utf8-plain-text');
    expect(text).toContain('350');
  });

  it('formats empty clipboard result', () => {
    const output = {
      primaryFormat: 'empty' as const,
      availableFormats: [],
      itemCount: 0,
      rawTypes: [],
    };
    const blocks = clipboardInspect.format!(output);
    const text = blocks.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('empty');
  });
});

describe('clipboardInspect — surfaced failures (#23)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function serviceThrowing(error: unknown) {
    mockGetService.mockReturnValueOnce({
      inspect: vi.fn().mockRejectedValueOnce(error),
    } as unknown as ReturnType<typeof getClipboardService>);
  }

  it('fails with the declared inspect_unreadable reason when the backend output is unreadable', async () => {
    serviceThrowing(inspectUnreadable('macOS', 'not json'));

    const ctx = createMockContext({ errors: clipboardInspect.errors });
    await expect(
      clipboardInspect.handler(clipboardInspect.input.parse({}), ctx),
    ).rejects.toMatchObject({
      data: {
        reason: 'inspect_unreadable',
        platform: 'macOS',
        recovery: { hint: expect.stringContaining('clipboard_inspect') },
      },
    });
  });

  it('keeps the unreadable-output detail in the failure message', async () => {
    serviceThrowing(inspectUnreadable('Windows', 'At line:1 char:1 + not json'));

    const ctx = createMockContext({ errors: clipboardInspect.errors });
    await expect(clipboardInspect.handler(clipboardInspect.input.parse({}), ctx)).rejects.toThrow(
      /unreadable output/i,
    );
  });

  it('fails clipboard_unavailable with the backend recovery hint when the helper cannot run (#36)', async () => {
    serviceThrowing(
      clipboardOutcome(
        'Linux Wayland',
        'wl-paste exited 1: Failed to connect to a Wayland server',
        {
          category: 'clipboard_unavailable',
          recoveryHint: 'Set WAYLAND_DISPLAY to a live compositor socket, then retry.',
        },
      ),
    );

    const ctx = createMockContext({ errors: clipboardInspect.errors });
    await expect(
      clipboardInspect.handler(clipboardInspect.input.parse({}), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'clipboard_unavailable',
        platform: 'Linux Wayland',
        recovery: { hint: 'Set WAYLAND_DISPLAY to a live compositor socket, then retry.' },
      },
    });
  });

  it('declares clipboard_unavailable naming install commands and session variables', () => {
    const entry = clipboardInspect.errors?.find((e) => e.reason === 'clipboard_unavailable');
    expect(entry?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(entry?.recovery).toMatch(/apt install xclip/);
    expect(entry?.recovery).toMatch(/WAYLAND_DISPLAY/);
  });

  it('rethrows an unrelated backend failure unchanged', async () => {
    serviceThrowing(new Error('xclip exited 1: cannot open display'));

    const ctx = createMockContext({ errors: clipboardInspect.errors });
    await expect(clipboardInspect.handler(clipboardInspect.input.parse({}), ctx)).rejects.toThrow(
      'xclip exited 1: cannot open display',
    );
  });

  it('declares inspect_unreadable with a recovery hint on the contract', () => {
    const entry = clipboardInspect.errors?.find((e) => e.reason === 'inspect_unreadable');
    expect(entry).toBeDefined();
    expect(entry?.recovery.split(/\s+/).length).toBeGreaterThanOrEqual(5);
  });

  it('carries a failed measurement through to structuredContent', async () => {
    const mockInspect = vi.fn().mockResolvedValueOnce({
      primaryFormat: 'image' as const,
      availableFormats: ['image' as const],
      itemCount: 1,
      rawTypes: [{ type: 'image/png', measurementFailed: true }],
    });
    mockGetService.mockReturnValueOnce({ inspect: mockInspect } as ReturnType<
      typeof getClipboardService
    >);

    const ctx = createMockContext({ errors: clipboardInspect.errors });
    const result = await clipboardInspect.handler(clipboardInspect.input.parse({}), ctx);

    expect(clipboardInspect.output.parse(result).rawTypes[0]).toEqual({
      type: 'image/png',
      measurementFailed: true,
    });
  });

  describe('format()', () => {
    function render(rawTypes: { bytes?: number; measurementFailed?: boolean; type: string }[]) {
      const blocks = clipboardInspect.format!({
        primaryFormat: 'text' as const,
        availableFormats: ['text' as const],
        itemCount: 1,
        rawTypes,
      });
      return blocks.find((b) => b.type === 'text')?.text ?? '';
    }

    it('marks a failed measurement instead of printing a zero size', () => {
      const text = render([{ type: 'image/png', measurementFailed: true }]);
      expect(text).toContain('image/png');
      expect(text).toContain('measurementFailed: true');
      expect(text).not.toMatch(/image\/png` \| 0 /);
    });

    it('renders a genuine zero-byte representation as 0', () => {
      const text = render([{ type: 'public.utf8-plain-text', bytes: 0 }]);
      expect(text).toContain('| 0 |');
      expect(text).not.toContain('measurementFailed');
    });

    it('renders measured and failed entries side by side', () => {
      const text = render([
        { type: 'public.utf8-plain-text', bytes: 1234 },
        { type: 'public.png', measurementFailed: true },
      ]);
      expect(text).toContain('1,234');
      expect(text).toContain('measurementFailed: true');
    });

    it('renders an unmeasured entry as unknown, without the failure note (#41)', () => {
      const text = render([{ type: 'TARGETS' }]);
      expect(text).toContain('| `TARGETS` | unknown |');
      expect(text).not.toContain('measurementFailed');
    });

    it('renders measured, zero-byte, unmeasured, and failed entries in one table (#41)', () => {
      const text = render([
        { type: 'UTF8_STRING', bytes: 5 },
        { type: 'text/html', bytes: 0 },
        { type: 'TIMESTAMP' },
        { type: 'image/png', measurementFailed: true },
      ]);
      expect(text).toContain('| `UTF8_STRING` | 5 |');
      expect(text).toContain('| `text/html` | 0 |');
      expect(text).toContain('| `TIMESTAMP` | unknown |');
      expect(text).toContain('| `image/png` | unknown (measurementFailed: true) |');
    });
  });

  describe('format() — raw type names read back as written (#58)', () => {
    function render(rawTypes: { bytes?: number; measurementFailed?: true; type: string }[]) {
      const blocks = clipboardInspect.format!({
        primaryFormat: 'text' as const,
        availableFormats: ['text' as const],
        itemCount: 1,
        rawTypes,
      });
      return blocks.find((b) => b.type === 'text')?.text ?? '';
    }

    /** A table row's cell separators: pipes no backslash escapes. */
    function separators(row: string): number {
      let count = 0;
      for (let i = 0; i < row.length; i++) if (row[i] === '|' && row[i - 1] !== '\\') count++;
      return count;
    }

    it('renders a type holding a pipe, a backtick, and emphasis as one literal cell', () => {
      const text = render([{ type: 'com.example.a|b`c**x**', bytes: 3 }]);
      expect(text).toContain('| ``com.example.a\\|b`c**x**`` | 3 |');
    });

    it.each([
      ['a trailing backtick', 'ends.with`', '| `` ends.with` `` | 3 |'],
      ['a leading backtick', '`starts', '| `` `starts `` | 3 |'],
      ['leading and trailing spaces', ' padded ', '| `  padded  ` | 3 |'],
      ['a backtick run', 'a``b```c', '| ````a``b```c```` | 3 |'],
    ])('keeps %s in one cell with its Bytes cell intact', (_label, type, row) => {
      const text = render([
        { type: 'public.utf8-plain-text', bytes: 5 },
        { type, bytes: 3 },
      ]);
      expect(text).toContain(row);
      expect(separators(row)).toBe(3);
      expect(text).toContain('| `public.utf8-plain-text` | 5 |');
    });

    it.each([
      ['LF', 'x\n\n# Injected'],
      ['CR', 'com.example.carriage\rreturn'],
      ['CRLF', 'com.example\r\n- list'],
      ['NUL', 'com.example.nul\u0000byte'],
      // GFM parsers disagree on `\\|` in a cell: cmark-gfm reads one escaped pipe, micromark a backslash and a cell break.
      ['backslash before a pipe', 'back\\|slash'],
    ])('renders every type as a fenced JSON block when one holds a %s', (_label, odd) => {
      const rawTypes = [
        { type: 'public.utf8-plain-text', bytes: 5 },
        { type: odd, bytes: 3 },
        { type: 'TARGETS' },
        { type: 'image/png', measurementFailed: true as const },
      ];
      const text = render(rawTypes);
      const fence = /\n(`{3,})json\n([\s\S]*)\n\1$/.exec(text);
      expect(fence?.[2]).toBeDefined();
      expect(JSON.parse(fence?.[2] ?? '')).toEqual(rawTypes);
      expect(text).not.toContain('| Type | Bytes |');
      // Nothing of the odd type sits outside the fence as live Markdown.
      const outside = text.slice(0, fence?.index ?? text.length);
      expect(outside).toBe(
        '**Primary format:** text\n**Available formats:** text\n**Item count:** 1\n\n**Raw types:**',
      );
    });

    it('characterization: ordinary types keep their current rows', () => {
      const text = render([
        { type: 'public.utf8-plain-text', bytes: 1234 },
        { type: 'TARGETS' },
        { type: 'image/png', measurementFailed: true },
      ]);
      expect(text).toContain(
        '| Type | Bytes |\n|:-----|------:|\n| `public.utf8-plain-text` | 1,234 |\n| `TARGETS` | unknown |\n| `image/png` | unknown (measurementFailed: true) |',
      );
    });

    it('leaves structuredContent untouched: the handler returns the service result as is', async () => {
      const rawTypes = [{ type: 'com.example.a|b`c**x**', bytes: 3 }];
      const inspection = {
        primaryFormat: 'text' as const,
        availableFormats: ['text' as const],
        itemCount: 1,
        rawTypes,
      };
      mockGetService.mockReturnValueOnce({
        inspect: vi.fn().mockResolvedValueOnce(inspection),
      } as unknown as ReturnType<typeof getClipboardService>);
      const ctx = createMockContext({ errors: clipboardInspect.errors });
      const result = await clipboardInspect.handler(clipboardInspect.input.parse({}), ctx);
      expect(clipboardInspect.output.parse(result)).toEqual(inspection);
    });
  });

  describe('itemCount and files (#57, #59)', () => {
    it('returns and renders the clipboard item count', async () => {
      const inspection = {
        primaryFormat: 'image' as const,
        availableFormats: ['image' as const],
        itemCount: 3,
        rawTypes: [{ type: 'public.png', bytes: 75 }],
      };
      mockGetService.mockReturnValueOnce({
        inspect: vi.fn().mockResolvedValueOnce(inspection),
      } as unknown as ReturnType<typeof getClipboardService>);
      const ctx = createMockContext({ errors: clipboardInspect.errors });
      const result = clipboardInspect.output.parse(
        await clipboardInspect.handler(clipboardInspect.input.parse({}), ctx),
      );
      expect(result.itemCount).toBe(3);
      const text = clipboardInspect.format!(result).find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain('**Item count:** 3');
    });

    it.each([0, 1])('renders an item count of %i', (itemCount) => {
      const text =
        clipboardInspect.format!({
          primaryFormat: itemCount === 0 ? ('empty' as const) : ('text' as const),
          availableFormats: itemCount === 0 ? [] : ['text' as const],
          itemCount,
          rawTypes: [],
        }).find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain(`**Item count:** ${itemCount}`);
    });

    it('accepts files as the primary and an available format', () => {
      const parsed = clipboardInspect.output.parse({
        primaryFormat: 'files',
        availableFormats: ['text', 'image', 'files'],
        itemCount: 3,
        rawTypes: [{ type: 'public.file-url', bytes: 56 }],
      });
      expect(parsed.primaryFormat).toBe('files');
      const text = clipboardInspect.format!(parsed).find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain('**Primary format:** files');
      expect(text).toContain('**Available formats:** text, image, files');
    });

    it('rejects an output with no item count', () => {
      expect(() =>
        clipboardInspect.output.parse({
          primaryFormat: 'empty',
          availableFormats: [],
          rawTypes: [],
        }),
      ).toThrow();
    });

    it('ranks files first and points itemCount at clipboard_read', () => {
      expect(clipboardInspect.description).toMatch(/files > image > html > rtf > text/);
      expect(clipboardInspect.output.shape.primaryFormat.description).toMatch(
        /files > image > html > rtf > text/,
      );
      expect(clipboardInspect.output.shape.itemCount.description).toMatch(/clipboard_read/);
    });
  });

  describe('output contract (#41)', () => {
    const entry = clipboardInspect.output.shape.rawTypes.element.shape;

    it('an unmeasured entry passes the output schema with no bytes', () => {
      expect(
        clipboardInspect.output.parse({
          primaryFormat: 'empty',
          availableFormats: [],
          itemCount: 1,
          rawTypes: [{ type: 'TARGETS' }],
        }).rawTypes[0],
      ).toEqual({ type: 'TARGETS' });
    });

    it('says bytes is absent for types the platform did not size, and 0 means present and empty', () => {
      expect(entry.bytes.description).toMatch(/did not size/);
      expect(entry.bytes.description).toMatch(/0 means/);
    });

    it('says a failed measurement does not make its format available', () => {
      expect(entry.measurementFailed.description).toMatch(/clipboard_read cannot return/);
      expect(entry.measurementFailed.description).not.toMatch(/may still return/);
    });

    it('says availableFormats lists only what clipboard_read can return', () => {
      expect(clipboardInspect.output.shape.availableFormats.description).toMatch(
        /clipboard_read can return/,
      );
    });
  });
});
