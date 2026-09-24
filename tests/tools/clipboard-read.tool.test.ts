/**
 * @fileoverview Tests for clipboard_read tool.
 * @module tests/tools/clipboard-read.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getContentBlocks } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboardRead } from '@/mcp-server/tools/definitions/clipboard-read.tool.js';
import { ClipboardService, SIZE_LIMITS } from '@/services/clipboard/clipboard-service.js';
import type { ByteRange, ClipboardBackend, ClipboardFormat } from '@/services/clipboard/types.js';
import { clipboardOutcome, inspectUnreadable } from '@/services/clipboard/types.js';
import { REAL_PNG_13x7 } from '../services/clipboard/png-fixtures.js';

vi.mock('@/services/clipboard/clipboard-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/clipboard/clipboard-service.js')>();
  return {
    ...actual,
    getClipboardService: vi.fn(),
    initClipboardService: vi.fn(),
  };
});

import { getClipboardService } from '@/services/clipboard/clipboard-service.js';

const mockGetService = vi.mocked(getClipboardService);

/** The token the mocked service reports for every read. */
const REP_ID = 'text:rev-1';

/** Shape a bare backend-style result the way ClipboardService.read() returns it: one complete slice. */
function asRangedRead<T extends { content: Buffer }>(r: T) {
  return {
    byteSize: r.content.byteLength,
    totalByteSize: r.content.byteLength,
    complete: true,
    representationId: REP_ID,
    ...r,
  };
}

/** Build a mock ClipboardService with inspect and read. */
function mockService(opts: {
  inspect?: ReturnType<ReturnType<typeof getClipboardService>['inspect']>;
  read?: ReturnType<ReturnType<typeof getClipboardService>['read']>;
}) {
  return {
    inspect: opts.inspect ? vi.fn().mockReturnValue(opts.inspect) : vi.fn(),
    read: opts.read ? vi.fn().mockImplementation(() => opts.read?.then(asRangedRead)) : vi.fn(),
  } as unknown as ReturnType<typeof getClipboardService>;
}

describe('clipboardRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('explicit format "text"', () => {
    it('reads plain text and returns utf-8 content', async () => {
      const svc = mockService({
        read: Promise.resolve({ format: 'text' as const, content: Buffer.from('hello world') }),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'text' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('text');
      expect(result.content).toBe('hello world');
      expect(result.byteSize).toBe(11);
    });

    it('round-trips unicode and emoji', async () => {
      const text = 'Hello 世界 🌍';
      const svc = mockService({
        read: Promise.resolve({ format: 'text' as const, content: Buffer.from(text, 'utf8') }),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'text' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.content).toBe(text);
    });
  });

  describe('explicit format "html"', () => {
    it('returns raw HTML content', async () => {
      const html = '<html><body><b>bold</b></body></html>';
      const svc = mockService({
        read: Promise.resolve({ format: 'html' as const, content: Buffer.from(html) }),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'html' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('html');
      expect(result.content).toContain('<html>');
    });
  });

  describe('explicit format "image"', () => {
    it('returns base64-encoded PNG with dimensions', async () => {
      const pngData = Buffer.from('fakepngdata');
      const svc = mockService({
        read: Promise.resolve({
          format: 'image' as const,
          content: pngData,
          width: 1920,
          height: 1080,
        }),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'image' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('image');
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.content).toBe(pngData.toString('base64'));
    });
  });

  describe('auto format', () => {
    it('selects image when image is available (highest priority)', async () => {
      const pngData = Buffer.from('fakepng');
      const svc = {
        inspect: vi.fn().mockResolvedValueOnce({
          primaryFormat: 'image' as const,
          availableFormats: ['text' as const, 'html' as const, 'image' as const],
          rawTypes: [],
        }),
        read: vi.fn().mockResolvedValueOnce({
          format: 'image' as const,
          content: pngData,
          width: 800,
          height: 600,
        }),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'auto' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('image');
    });

    it('selects html when only html and text are available', async () => {
      const svc = {
        inspect: vi.fn().mockResolvedValueOnce({
          primaryFormat: 'html' as const,
          availableFormats: ['text' as const, 'html' as const],
          rawTypes: [],
        }),
        read: vi.fn().mockResolvedValueOnce({
          format: 'html' as const,
          content: Buffer.from('<html>hi</html>'),
        }),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'auto' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('html');
    });

    it('falls back to text when only text is available', async () => {
      const svc = {
        inspect: vi.fn().mockResolvedValueOnce({
          primaryFormat: 'text' as const,
          availableFormats: ['text' as const],
          rawTypes: [],
        }),
        read: vi
          .fn()
          .mockResolvedValueOnce({ format: 'text' as const, content: Buffer.from('plain') }),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'auto' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('text');
    });

    it('throws format_unavailable when clipboard is empty', async () => {
      const svc = {
        inspect: vi.fn().mockResolvedValueOnce({
          primaryFormat: 'empty' as const,
          availableFormats: [],
          rawTypes: [],
        }),
        read: vi.fn(),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'auto' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'format_unavailable' },
      });
    });

    it('does not read when raw platform types have no semantic format', async () => {
      const svc = {
        inspect: vi.fn().mockResolvedValueOnce({
          primaryFormat: 'empty' as const,
          availableFormats: [],
          rawTypes: [{ type: 'NSFilenamesPboardType', bytes: 128 }],
        }),
        read: vi.fn(),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'auto' });

      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'format_unavailable' },
      });
      expect(svc.read).not.toHaveBeenCalled();
    });
  });

  describe('error: format_unavailable', () => {
    it('throws format_unavailable when the backend reports the format absent', async () => {
      const svc = mockService({
        read: Promise.reject(
          clipboardOutcome('macOS', 'HTML format not found on clipboard', {
            category: 'format_unavailable',
          }),
        ),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'html' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'format_unavailable',
          requestedFormat: 'html',
          recovery: { hint: expect.stringContaining('clipboard_inspect') },
        },
      });
    });

    it('throws format_unavailable for text when the backend reports an empty clipboard', async () => {
      const svc = mockService({
        read: Promise.reject(
          clipboardOutcome('Linux Wayland', 'wl-paste exited 1: Nothing is copied', {
            category: 'empty',
          }),
        ),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'text' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        message: expect.stringMatching(/empty/i),
        data: { reason: 'format_unavailable' },
      });
    });

    it('does not read message text: an untyped "not found" error is not format_unavailable', async () => {
      const svc = mockService({
        read: Promise.reject(new Error('xclip not found — install with: apt install xclip')),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'rtf' });
      const failure = clipboardRead.handler(input, ctx);
      await expect(failure).rejects.toThrow('xclip not found — install with: apt install xclip');
      await expect(failure).rejects.not.toHaveProperty('data.reason');
    });
  });

  describe('error: clipboard_unavailable', () => {
    it('carries the backend-specific recovery hint on the wire', async () => {
      const svc = mockService({
        read: Promise.reject(
          clipboardOutcome('Linux X11', "xclip exited 1: Error: Can't open display: :98", {
            category: 'clipboard_unavailable',
            recoveryHint: 'Set DISPLAY to a running X server, then retry.',
          }),
        ),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'text' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'clipboard_unavailable',
          platform: 'Linux X11',
          recovery: { hint: 'Set DISPLAY to a running X server, then retry.' },
        },
      });
    });

    it('maps an unavailable clipboard during the auto-mode inspection', async () => {
      const svc = {
        inspect: vi.fn().mockRejectedValueOnce(
          clipboardOutcome('Linux Wayland', 'wl-paste not found', {
            category: 'clipboard_unavailable',
            recoveryHint: 'Install wl-clipboard (apt install wl-clipboard), then retry.',
          }),
        ),
        read: vi.fn(),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      await expect(
        clipboardRead.handler(clipboardRead.input.parse({ format: 'auto' }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'clipboard_unavailable' } });
      expect(svc.read).not.toHaveBeenCalled();
    });

    it('declares clipboard_unavailable with a recovery naming install commands and session variables', () => {
      const entry = clipboardRead.errors?.find((e) => e.reason === 'clipboard_unavailable');
      expect(entry?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(entry?.recovery).toMatch(/apt install xclip/);
      expect(entry?.recovery).toMatch(/apt install wl-clipboard/);
      expect(entry?.recovery).toMatch(/DISPLAY/);
      expect(entry?.recovery).toMatch(/WAYLAND_DISPLAY/);
    });
  });

  describe('error: inspect_unreadable (#45)', () => {
    function inspectFailing(error: unknown) {
      const svc = {
        inspect: vi.fn().mockRejectedValueOnce(error),
        read: vi.fn(),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);
      return svc;
    }

    it('maps an unreadable auto-mode inspection to the declared inspect_unreadable reason', async () => {
      const svc = inspectFailing(inspectUnreadable('macOS', 'not json'));
      const ctx = createMockContext({ errors: clipboardRead.errors });
      const failure = clipboardRead.handler(clipboardRead.input.parse({ format: 'auto' }), ctx);
      await expect(failure).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        data: {
          reason: 'inspect_unreadable',
          platform: 'macOS',
          recovery: { hint: expect.stringContaining('clipboard_read') },
        },
      });
      expect(svc.read).not.toHaveBeenCalled();
    });

    it('carries no helper output in the error data', async () => {
      inspectFailing(inspectUnreadable('Windows', 'At line:1 char:1 secret-helper-output'));
      const ctx = createMockContext({ errors: clipboardRead.errors });
      const error = await clipboardRead
        .handler(clipboardRead.input.parse({ format: 'auto' }), ctx)
        .catch((err: unknown) => err as { data?: unknown });
      expect(JSON.stringify(error.data)).not.toContain('secret-helper-output');
    });

    it('declares inspect_unreadable as a SerializationError whose recovery names clipboard_read', () => {
      const entry = clipboardRead.errors?.find((e) => e.reason === 'inspect_unreadable');
      expect(entry?.code).toBe(JsonRpcErrorCode.SerializationError);
      expect(entry?.recovery).toMatch(/clipboard_read/);
      expect(entry?.recovery).toMatch(/explicit format/);
    });

    it('characterization: an unrelated inspection failure still rethrows untyped', async () => {
      inspectFailing(new Error('osascript exited 1: execution error'));
      const ctx = createMockContext({ errors: clipboardRead.errors });
      const failure = clipboardRead.handler(clipboardRead.input.parse({ format: 'auto' }), ctx);
      await expect(failure).rejects.toThrow('osascript exited 1: execution error');
      await expect(failure).rejects.not.toHaveProperty('data.reason');
    });
  });

  describe('error: content_too_large', () => {
    it('throws content_too_large when service signals size exceeded', async () => {
      const oversized = Object.assign(new Error('content_too_large'), {
        _contentTooLarge: true,
        bytes: SIZE_LIMITS.READ_TEXT + 1,
        limit: SIZE_LIMITS.READ_TEXT,
        format: 'text',
      });
      const svc = mockService({
        read: Promise.reject(oversized),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'text' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'content_too_large', bytes: SIZE_LIMITS.READ_TEXT + 1 },
      });
    });
  });

  describe('explicit format "rtf"', () => {
    it('returns raw RTF content', async () => {
      const rtf = '{\\rtf1\\ansi Hello World}';
      const svc = mockService({
        read: Promise.resolve({ format: 'rtf' as const, content: Buffer.from(rtf) }),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'rtf' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('rtf');
      expect(result.content).toBe(rtf);
      expect(result.byteSize).toBe(Buffer.byteLength(rtf, 'utf8'));
    });

    it('throws format_unavailable when RTF not present', async () => {
      const svc = mockService({
        read: Promise.reject(
          clipboardOutcome('Windows', 'RTF format not found on clipboard', {
            category: 'format_unavailable',
          }),
        ),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'rtf' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'format_unavailable' },
      });
    });
  });

  describe('auto format — rtf priority', () => {
    it('selects rtf when rtf and text are available (rtf > text)', async () => {
      const rtf = '{\\rtf1 Content}';
      const svc = {
        inspect: vi.fn().mockResolvedValueOnce({
          primaryFormat: 'rtf' as const,
          availableFormats: ['text' as const, 'rtf' as const],
          rawTypes: [],
        }),
        read: vi.fn().mockResolvedValueOnce({ format: 'rtf' as const, content: Buffer.from(rtf) }),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'auto' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('rtf');
    });

    it('selects html over rtf when both are available (html > rtf)', async () => {
      const svc = {
        inspect: vi.fn().mockResolvedValueOnce({
          primaryFormat: 'html' as const,
          availableFormats: ['text' as const, 'rtf' as const, 'html' as const],
          rawTypes: [],
        }),
        read: vi.fn().mockResolvedValueOnce({
          format: 'html' as const,
          content: Buffer.from('<html>rich</html>'),
        }),
      } as unknown as ReturnType<typeof getClipboardService>;
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'auto' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result.format).toBe('html');
    });
  });

  describe('format()', () => {
    it('renders text format with content and size', () => {
      const output = {
        format: 'text' as const,
        content: 'hello world',
        byteSize: 11,
        totalByteSize: 11,
        complete: true,
      };
      const blocks = clipboardRead.format!(output);
      const text = blocks.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain('text');
      expect(text).toContain('11');
      expect(text).toContain('hello world');
    });

    it('renders rtf format with content', () => {
      const output = {
        format: 'rtf' as const,
        content: '{\\rtf1 Hello}',
        byteSize: 13,
        totalByteSize: 13,
        complete: true,
      };
      const blocks = clipboardRead.format!(output);
      const text = blocks.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain('rtf');
      expect(text).toContain('13');
    });

    it('renders image format with dimensions — no base64 blob', () => {
      const output = {
        format: 'image' as const,
        content: 'ZmFrZWJhc2U2NA==',
        width: 1920,
        height: 1080,
        byteSize: 51200,
        totalByteSize: 51200,
        complete: true,
      };
      const blocks = clipboardRead.format!(output);
      const text = blocks.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain('1920');
      expect(text).toContain('1080');
      // Should NOT dump the raw base64 string
      expect(text).not.toContain('ZmFrZWJhc2U2NA==');
      expect(text).toContain('structuredContent');
    });
  });
});

describe('clipboardRead — response-surface characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('format() invariants', () => {
    it.each([
      ['text' as const, 'plain payload'],
      ['html' as const, '<table><tr><td>A &amp; B</td><td>*literal*</td></tr></table>'],
      ['rtf' as const, '{\\rtf1\\ansi Hello}'],
    ])('renders the %s payload in full alongside format and size', (format, content) => {
      const output = {
        format,
        content,
        byteSize: Buffer.byteLength(content, 'utf8'),
        totalByteSize: Buffer.byteLength(content, 'utf8'),
        complete: true,
      };
      const blocks = clipboardRead.format!(output);
      const text = blocks.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain(`**Format:** ${format}`);
      expect(text).toContain(String(output.byteSize));
      expect(text).toContain(content);
    });

    it('emits exactly one text block', () => {
      const blocks = clipboardRead.format!({
        format: 'text',
        content: 'x',
        byteSize: 1,
        totalByteSize: 1,
        complete: true,
      });
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('text');
    });
  });

  describe('handler structuredContent invariants', () => {
    it('returns base64 content and dimensions for an image without altering structuredContent', async () => {
      const png = Buffer.from('characterization-png-bytes');
      const svc = mockService({
        read: Promise.resolve({
          format: 'image' as const,
          content: png,
          width: 10,
          height: 20,
        }),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'image' });
      const result = await clipboardRead.handler(input, ctx);
      expect(result).toEqual({
        format: 'image',
        content: png.toString('base64'),
        width: 10,
        height: 20,
        byteSize: png.byteLength,
        totalByteSize: png.byteLength,
        complete: true,
        representationId: REP_ID,
      });
    });

    it('attaches no content blocks for a text read', async () => {
      const svc = mockService({
        read: Promise.resolve({ format: 'text' as const, content: Buffer.from('plain') }),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'text' });
      await clipboardRead.handler(input, ctx);
      expect(getContentBlocks(ctx)).toEqual([]);
    });
  });
});

/**
 * Pull the fenced payload out of a rendered clipboard_read text block: the
 * opening fence run, and the bytes between the fences.
 */
function fencedPayload(text: string): { fence: string; payload: string } | undefined {
  const match = /(?:^|\n)(`{3,})[^\n]*\n([\s\S]*)\n\1(?:\n|$)/.exec(text);
  if (!match?.[1] || match[2] === undefined) return undefined;
  return { fence: match[1], payload: match[2] };
}

/** Longest run of consecutive backticks in a string. */
function longestBacktickRun(s: string): number {
  let longest = 0;
  for (const [run] of s.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  return longest;
}

describe('clipboardRead format() — literal payload preservation (#22)', () => {
  function render(format: 'text' | 'html' | 'rtf', content: string): string {
    const blocks = clipboardRead.format!({
      format,
      content,
      byteSize: Buffer.byteLength(content, 'utf8'),
      totalByteSize: Buffer.byteLength(content, 'utf8'),
      complete: true,
    });
    return blocks.find((b) => b.type === 'text')?.text ?? '';
  }

  it('fences an HTML table so tags and emphasis markers cannot control rendering', () => {
    const html = '<table><tr><td>A &amp; B</td><td>*literal*</td></tr></table>';
    const fenced = fencedPayload(render('html', html));
    expect(fenced?.payload).toBe(html);
  });

  it.each([
    ['pipes and emphasis', 'a | b | c **bold** _under_ ~~strike~~'],
    ['angle brackets', '<img src=x onerror=alert(1)> <b>hi</b>'],
    ['markdown headings and lists', '# Heading\n- item\n> quote'],
    ['multiline text', 'line one\nline two\nline three'],
    ['leading and trailing whitespace', '   padded   '],
  ])('preserves %s byte-for-byte inside the fence', (_label, content) => {
    const fenced = fencedPayload(render('text', content));
    expect(fenced?.payload).toBe(content);
  });

  it('outgrows a backtick run in the payload', () => {
    const content = 'inline ```` four ```` ticks';
    const fenced = fencedPayload(render('text', content));
    expect(fenced?.payload).toBe(content);
    expect(fenced!.fence.length).toBeGreaterThan(longestBacktickRun(content));
  });

  it('outgrows a nested code fence in the payload', () => {
    const content = 'before\n```js\nconst x = 1;\n```\nafter';
    const fenced = fencedPayload(render('html', content));
    expect(fenced?.payload).toBe(content);
    expect(fenced!.fence.length).toBeGreaterThan(3);
  });

  it('outgrows a payload that is nothing but backticks', () => {
    const content = '`````';
    const fenced = fencedPayload(render('rtf', content));
    expect(fenced?.payload).toBe(content);
    expect(fenced!.fence.length).toBe(6);
  });

  it.each(['text' as const, 'html' as const, 'rtf' as const])('fences the %s branch', (format) => {
    const content = `payload for ${format}`;
    const text = render(format, content);
    expect(fencedPayload(text)?.payload).toBe(content);
    expect(text).toContain(`**Format:** ${format}`);
  });

  it('leaves structuredContent-bound values untouched — format() stays pure', () => {
    const output = {
      format: 'text' as const,
      content: '`tick`',
      byteSize: 6,
      totalByteSize: 6,
      complete: true,
    };
    const snapshot = { ...output };
    clipboardRead.format!(output);
    expect(output).toEqual(snapshot);
  });
});

describe('clipboardRead handler — image block on content[] (#6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attaches the PNG bytes as an image block on an explicit image read', async () => {
    const png = Buffer.from('fake-png-bytes-for-explicit-read');
    const svc = mockService({
      read: Promise.resolve({ format: 'image' as const, content: png, width: 10, height: 20 }),
    });
    mockGetService.mockReturnValueOnce(svc);

    const ctx = createMockContext({ errors: clipboardRead.errors });
    const input = clipboardRead.input.parse({ format: 'image' });
    const result = await clipboardRead.handler(input, ctx);

    // content[] carries the image block...
    expect(getContentBlocks(ctx)).toEqual([
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ]);
    // ...and structuredContent is unchanged, asserted independently.
    expect(result).toEqual({
      format: 'image',
      content: png.toString('base64'),
      width: 10,
      height: 20,
      byteSize: png.byteLength,
      totalByteSize: png.byteLength,
      complete: true,
      representationId: REP_ID,
    });
  });

  it('attaches the PNG bytes when auto resolves to image', async () => {
    const png = Buffer.from('fake-png-bytes-for-auto-read');
    const svc = {
      inspect: vi.fn().mockResolvedValueOnce({
        primaryFormat: 'image' as const,
        availableFormats: ['text' as const, 'image' as const],
        rawTypes: [],
      }),
      read: vi
        .fn()
        .mockResolvedValueOnce(
          asRangedRead({ format: 'image' as const, content: png, width: 8, height: 6 }),
        ),
    } as unknown as ReturnType<typeof getClipboardService>;
    mockGetService.mockReturnValueOnce(svc);

    const ctx = createMockContext({ errors: clipboardRead.errors });
    const input = clipboardRead.input.parse({ format: 'auto' });
    const result = await clipboardRead.handler(input, ctx);

    expect(getContentBlocks(ctx)).toEqual([
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ]);
    expect(result.content).toBe(png.toString('base64'));
    expect(result.width).toBe(8);
    expect(result.height).toBe(6);
  });

  it.each(['html' as const, 'rtf' as const])(
    'attaches no content block for a %s read',
    async (format) => {
      const svc = mockService({
        read: Promise.resolve({ format, content: Buffer.from('<p>x</p>') }),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format });
      await clipboardRead.handler(input, ctx);
      expect(getContentBlocks(ctx)).toEqual([]);
    },
  );

  it('attaches no content block when the image read fails', async () => {
    const svc = mockService({
      read: Promise.reject(
        clipboardOutcome('macOS', 'Image format not found on clipboard', {
          category: 'format_unavailable',
        }),
      ),
    });
    mockGetService.mockReturnValueOnce(svc);

    const ctx = createMockContext({ errors: clipboardRead.errors });
    const input = clipboardRead.input.parse({ format: 'image' });
    await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'format_unavailable' },
    });
    expect(getContentBlocks(ctx)).toEqual([]);
  });
});

describe('clipboardRead — bounded retrieval (#7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [{ format: 'text', offset: -1 }],
    [{ format: 'text', offset: 1.5 }],
    [{ format: 'text', limit: 0 }],
    [{ format: 'text', limit: 3 }],
    [{ format: 'text', limit: -8 }],
  ])('rejects %j at the input schema', (input) => {
    expect(() => clipboardRead.input.parse(input)).toThrow();
  });

  it('accepts the smallest progress-guaranteeing limit and an offset on its own', () => {
    expect(clipboardRead.input.parse({ format: 'text', limit: 4 })).toMatchObject({ limit: 4 });
    expect(clipboardRead.input.parse({ format: 'text', offset: 0 })).toMatchObject({ offset: 0 });
  });

  it('the limit description matches the handler: offset alone is a valid ranged read', () => {
    const description = clipboardRead.input.shape.limit.description ?? '';
    expect(description).not.toMatch(/Required alongside offset/);
    expect(description).toMatch(/passing offset without limit returns up to the format size limit/);
  });

  it('passes no range to the service when neither offset nor limit is given', async () => {
    const svc = mockService({
      read: Promise.resolve({ format: 'text' as const, content: Buffer.from('x') }),
    });
    mockGetService.mockReturnValueOnce(svc);
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await clipboardRead.handler(clipboardRead.input.parse({ format: 'text' }), ctx);
    expect(svc.read).toHaveBeenCalledWith('text', ctx, undefined);
  });

  it('passes the caller range through, defaulting a missing side so the service clamp applies', async () => {
    const svc = mockService({
      read: Promise.resolve({ format: 'text' as const, content: Buffer.from('x') }),
    });
    mockGetService.mockReturnValue(svc);
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await clipboardRead.handler(
      clipboardRead.input.parse({ format: 'text', offset: 8, limit: 16 }),
      ctx,
    );
    expect(svc.read).toHaveBeenLastCalledWith('text', ctx, { offset: 8, limit: 16 });
    await clipboardRead.handler(clipboardRead.input.parse({ format: 'text', offset: 8 }), ctx);
    expect(svc.read).toHaveBeenLastCalledWith('text', ctx, {
      offset: 8,
      limit: Number.MAX_SAFE_INTEGER,
    });
    await clipboardRead.handler(clipboardRead.input.parse({ format: 'text', limit: 4 }), ctx);
    expect(svc.read).toHaveBeenLastCalledWith('text', ctx, { offset: 0, limit: 4 });
  });

  it('applies the range to the format auto resolves to', async () => {
    const svc = mockService({
      inspect: Promise.resolve({
        primaryFormat: 'html',
        availableFormats: ['html', 'text'],
        rawTypes: [],
      }),
      read: Promise.resolve({ format: 'html' as const, content: Buffer.from('<p>x</p>') }),
    });
    mockGetService.mockReturnValueOnce(svc);
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await clipboardRead.handler(
      clipboardRead.input.parse({ format: 'auto', offset: 0, limit: 64 }),
      ctx,
    );
    expect(svc.read).toHaveBeenCalledWith('html', ctx, { offset: 0, limit: 64 });
  });

  it('a partial slice carries the same bytes and continuation metadata on both surfaces', async () => {
    const content = 'slice-of-`code`-payload';
    const slice = {
      format: 'text' as const,
      content: Buffer.from(content),
      byteSize: Buffer.byteLength(content),
      totalByteSize: 4096,
      complete: false,
      nextOffset: 512,
    };
    mockGetService.mockReturnValueOnce(mockService({ read: Promise.resolve(slice) }));
    const ctx = createMockContext({ errors: clipboardRead.errors });
    const result = await clipboardRead.handler(
      clipboardRead.input.parse({ format: 'text', offset: 489, limit: 23 }),
      ctx,
    );

    expect(result).toEqual({
      format: 'text',
      content,
      byteSize: 23,
      totalByteSize: 4096,
      complete: false,
      nextOffset: 512,
      representationId: REP_ID,
    });
    const text = clipboardRead.format!(result).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('23 of 4,096 bytes');
    expect(text).toContain('**Complete:** false');
    expect(text).toContain('**Next offset:** 512');
    expect(text).toContain(`**Representation ID:** ${REP_ID}`);
    expect(fencedPayload(text)?.payload).toBe(content);
  });

  it('a final slice renders complete with no next offset', () => {
    const text =
      clipboardRead.format!({
        format: 'text',
        content: 'tail',
        byteSize: 4,
        totalByteSize: 4096,
        complete: true,
      }).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('**Complete:** true');
    expect(text).not.toContain('Next offset');
  });

  it('an empty past-the-end slice renders as complete with an empty fence', () => {
    const output = {
      format: 'text' as const,
      content: '',
      byteSize: 0,
      totalByteSize: 10,
      complete: true,
    };
    const text = clipboardRead.format!(output).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('0 of 10 bytes');
    expect(text).toContain('**Complete:** true');
  });

  it('the description lists image among the zero-byte formats that return empty content (#43)', () => {
    expect(clipboardRead.description).toMatch(
      /A text, HTML, RTF, or image format that is present but zero bytes long returns empty content/,
    );
  });

  it('content_too_large recovery points at offset/limit', () => {
    const entry = clipboardRead.errors?.find((e) => e.reason === 'content_too_large');
    expect(entry?.recovery).toMatch(/offset/);
    expect(entry?.recovery).toMatch(/limit/);
    expect(entry?.recovery).toMatch(/nextOffset/);
  });
});

describe('clipboardRead format() — text, HTML, and RTF slice rendering (characterization)', () => {
  // #38 added the Representation ID line; #32 leaves these branches untouched.
  it.each(['text' as const, 'html' as const, 'rtf' as const])(
    'renders a partial %s slice exactly as before',
    (format) => {
      const text =
        clipboardRead.format!({
          format,
          content: 'ab`c',
          byteSize: 4,
          totalByteSize: 10,
          complete: false,
          nextOffset: 4,
          representationId: `${format}:rev`,
        }).find((b) => b.type === 'text')?.text ?? '';
      expect(text).toBe(
        `**Format:** ${format}\n**Size:** 4 of 10 bytes\n**Complete:** false\n**Next offset:** 4\n**Representation ID:** ${format}:rev\n\n\`\`\`\nab\`c\n\`\`\``,
      );
    },
  );
});

/**
 * A backend holding one PNG, sliced the way the real backends slice: the
 * `[offset, offset + limit)` window plus the true total. Served through the
 * real ClipboardService, so the tool sees exactly what a live read returns.
 */
function servePng(png: Buffer) {
  const backend = {
    clear: vi.fn(),
    inspect: vi.fn().mockResolvedValue({
      primaryFormat: 'image',
      availableFormats: ['image'],
      rawTypes: [{ type: 'public.png', bytes: png.byteLength }],
    }),
    read: vi.fn(async (_format: string, range: ByteRange) => ({
      format: 'image' as const,
      content: png.subarray(range.offset, range.offset + range.limit),
      totalByteSize: png.byteLength,
      revision: 'png-rev',
      width: 13,
      height: 7,
    })),
    write: vi.fn(),
  } as unknown as ClipboardBackend;
  mockGetService.mockReturnValue(new ClipboardService(backend));
}

/** Run one clipboard_read call and collect both surfaces. */
async function readBothSurfaces(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: clipboardRead.errors });
  const result = await clipboardRead.handler(clipboardRead.input.parse(input), ctx);
  const text = clipboardRead.format!(result).find((b) => b.type === 'text')?.text ?? '';
  const images = getContentBlocks(ctx).filter((b) => b.type === 'image');
  return { result, text, images };
}

describe('clipboardRead — image slices are PNG byte chunks, not images (#32)', () => {
  const png = REAL_PNG_13x7;
  const total = png.byteLength;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['unranged', { format: 'image' }],
    ['offset 0 with limit equal to the total', { format: 'image', offset: 0, limit: total }],
    ['offset 0 with limit one past the total', { format: 'image', offset: 0, limit: total + 1 }],
    ['auto, unranged', { format: 'auto' }],
  ])(
    'a whole-representation read (%s) emits one image block and no base64 text',
    async (_label, input) => {
      servePng(png);
      const { result, text, images } = await readBothSurfaces(input);
      expect(result).toMatchObject({ byteSize: total, totalByteSize: total, complete: true });
      expect(images).toEqual([
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ]);
      expect(text).not.toContain(png.toString('base64'));
      expect(text).not.toContain('```');
    },
  );

  it.each([
    ['first', 0, 7],
    ['first, one byte short of the whole', 0, total - 1],
    ['middle', 7, 7],
    ['final', total - 5, 7],
  ])(
    'a %s partial slice emits no image block and carries its base64 in the text',
    async (_label, offset, limit) => {
      for (const format of ['image', 'auto'] as const) {
        servePng(png);
        const { result, text, images } = await readBothSurfaces({ format, offset, limit });
        const expected = png.subarray(offset, offset + limit);
        expect(images, format).toEqual([]);
        expect(result.content).toBe(expected.toString('base64'));
        expect(fencedPayload(text)?.payload).toBe(result.content);
        expect(text).toContain(
          `**Byte range:** bytes ${offset} through ${offset + expected.byteLength - 1}`,
        );
        expect(text).toMatch(/base64-decode each chunk separately/i);
        expect(text).toMatch(/concatenate the bytes in offset order/i);
        expect(text).toContain(`**Complete:** ${result.complete}`);
        if (result.nextOffset === undefined) {
          expect(result.complete).toBe(true);
          expect(text).not.toContain('Next offset');
        } else {
          expect(text).toContain(`**Next offset:** ${result.nextOffset}`);
        }
      }
    },
  );

  it('the final slice is complete and still emits no image block', async () => {
    servePng(png);
    const { result, images } = await readBothSurfaces({
      format: 'image',
      offset: total - 5,
      limit: 7,
    });
    expect(result).toMatchObject({ byteSize: 5, complete: true });
    expect(images).toEqual([]);
  });

  it.each([total, total + 1, total + 10_000])(
    'an empty slice at offset %i emits no block and renders no base64',
    async (offset) => {
      servePng(png);
      const { result, text, images } = await readBothSurfaces({
        format: 'image',
        offset,
        limit: 7,
      });
      expect(result).toMatchObject({ content: '', byteSize: 0, complete: true });
      expect(images).toEqual([]);
      expect(text).not.toContain('```');
      expect(text).not.toContain('Byte range');
    },
  );

  it('decoding each chunk from the text and concatenating reproduces the whole read byte for byte', async () => {
    servePng(png);
    const whole = await readBothSurfaces({ format: 'image' });
    const chunkSize = 7; // not a multiple of 3, so chunk base64 cannot be joined as text
    const bytes: Buffer[] = [];
    let offset: number | undefined = 0;
    let chunks = 0;
    while (offset !== undefined) {
      const { result, text } = await readBothSurfaces({
        format: 'image',
        offset,
        limit: chunkSize,
      });
      const payload = fencedPayload(text)?.payload;
      expect(payload).toBeDefined();
      bytes.push(Buffer.from(payload ?? '', 'base64'));
      offset = result.nextOffset;
      chunks++;
    }
    expect(chunks).toBe(Math.ceil(total / chunkSize));
    expect(Buffer.concat(bytes).equals(Buffer.from(whole.result.content, 'base64'))).toBe(true);
  });

  it('the description, the content output description, and the content_too_large hint call image slices byte chunks', () => {
    const chunkWording = /PNG byte chunks?, not (?:a )?standalone images?/;
    expect(clipboardRead.description).toMatch(chunkWording);
    expect(clipboardRead.output.shape.content.description).toMatch(chunkWording);
    expect(clipboardRead.errors?.find((e) => e.reason === 'content_too_large')?.recovery).toMatch(
      chunkWording,
    );
  });
});

describe('clipboardRead — auto falls through a format that reads as absent (#46)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const absent = (format: string) =>
    clipboardOutcome('macOS', `${format} format not found on clipboard`, {
      category: 'format_unavailable',
    });

  /** A service listing `available`, whose read of each format resolves or rejects per `reads`. */
  function serve(
    available: ClipboardFormat[],
    reads: Partial<Record<ClipboardFormat, () => Promise<unknown>>>,
  ) {
    const read = vi.fn(async (format: ClipboardFormat) => {
      const reply = reads[format];
      if (!reply) throw new Error(`unexpected read of ${format}`);
      return reply();
    });
    mockGetService.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        primaryFormat: available.at(-1) ?? 'empty',
        availableFormats: available,
        rawTypes: available.map((type) => ({ type, bytes: 3 })),
      }),
      read,
    } as unknown as ReturnType<typeof getClipboardService>);
    return read;
  }

  const text = () => async () =>
    asRangedRead({
      format: 'text' as const,
      content: Buffer.from('abc'),
      representationId: 'text:rev-2',
    });

  it('characterization: auto reads its first choice when that succeeds, and reads nothing else', async () => {
    const read = serve(['text', 'image'], {
      image: async () => asRangedRead({ format: 'image' as const, content: REAL_PNG_13x7 }),
    });
    const { result } = await readBothSurfaces({ format: 'auto' });
    expect(result.format).toBe('image');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('characterization: an explicit format that reads as absent still fails, with no fallback', async () => {
    const read = serve(['text', 'image'], {
      image: () => Promise.reject(absent('Image')),
      text: text(),
    });
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await expect(
      clipboardRead.handler(clipboardRead.input.parse({ format: 'image' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'format_unavailable', requestedFormat: 'image' } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('characterization: auto over a lone image that reads as absent fails format_unavailable', async () => {
    serve(['image'], { image: () => Promise.reject(absent('Image')) });
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await expect(
      clipboardRead.handler(clipboardRead.input.parse({ format: 'auto' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'format_unavailable', requestedFormat: 'image' } });
  });

  it.each([
    [
      'representation_changed',
      () => clipboardOutcome('macOS', 'changed', { category: 'representation_changed' }),
    ],
    [
      'clipboard_unavailable',
      () =>
        clipboardOutcome('Windows', 'no powershell', {
          category: 'clipboard_unavailable',
          recoveryHint: 'Install PowerShell.',
        }),
    ],
  ])('characterization: %s on the first choice stops auto', async (reason, error) => {
    const read = serve(['text', 'image'], {
      image: () => Promise.reject(error()),
      text: text(),
    });
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await expect(
      clipboardRead.handler(clipboardRead.input.parse({ format: 'auto' }), ctx),
    ).rejects.toMatchObject({ data: { reason } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('auto moves past formats that read as absent to the next listed one', async () => {
    const read = serve(['text', 'rtf', 'image'], {
      image: () => Promise.reject(absent('Image')),
      rtf: () => Promise.reject(absent('RTF')),
      text: text(),
    });
    const { result, images } = await readBothSurfaces({ format: 'auto' });
    expect(result).toMatchObject({
      format: 'text',
      content: 'abc',
      representationId: 'text:rev-2',
    });
    expect(images).toEqual([]);
    expect(read.mock.calls.map(([format]) => format)).toEqual(['image', 'rtf', 'text']);
  });

  it('an auto continuation compares its token against the format actually read', async () => {
    serve(['text', 'image'], { image: () => Promise.reject(absent('Image')), text: text() });
    const matching = await readBothSurfaces({
      format: 'auto',
      offset: 0,
      limit: 8,
      representationId: 'text:rev-2',
    });
    expect(matching.result.content).toBe('abc');

    const ctx = createMockContext({ errors: clipboardRead.errors });
    await expect(
      clipboardRead.handler(
        clipboardRead.input.parse({ format: 'auto', offset: 0, representationId: 'image:rev-2' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      data: { reason: 'representation_changed', requestedFormat: 'text' },
    });
  });
});

describe('clipboardRead — representationId (#38)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const RECOVERY =
    'The clipboard changed during the read — after an earlier slice, or while this call was reading. Discard the bytes read so far and restart at offset 0 without representationId.';

  it('declares representation_changed as a Conflict with the ruled recovery', () => {
    const entry = clipboardRead.errors?.find((e) => e.reason === 'representation_changed');
    expect(entry?.code).toBe(JsonRpcErrorCode.Conflict);
    expect(entry?.recovery).toBe(RECOVERY);
  });

  it('returns the service token on both surfaces', async () => {
    servePng(REAL_PNG_13x7);
    for (const input of [
      { format: 'image' },
      { format: 'image', offset: 0, limit: 7 },
      { format: 'auto', offset: 7, limit: 7 },
    ]) {
      const { result, text } = await readBothSurfaces(input);
      expect(result.representationId).toBe('image:png-rev');
      expect(text).toContain('**Representation ID:** image:png-rev');
    }
  });

  it('a matching representationId returns the slice unchanged', async () => {
    servePng(REAL_PNG_13x7);
    const plain = await readBothSurfaces({ format: 'image', offset: 7, limit: 7 });
    servePng(REAL_PNG_13x7);
    const continued = await readBothSurfaces({
      format: 'image',
      offset: 7,
      limit: 7,
      representationId: 'image:png-rev',
    });
    expect(continued.result).toEqual(plain.result);
  });

  it.each([
    ['a partial slice', { offset: 7, limit: 7 }],
    ['a whole image', {}],
  ])('a different token on %s fails with no bytes and no image block', async (_label, range) => {
    servePng(REAL_PNG_13x7);
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await expect(
      clipboardRead.handler(
        clipboardRead.input.parse({ format: 'image', ...range, representationId: 'image:stale' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'representation_changed', recovery: { hint: RECOVERY } },
    });
    expect(getContentBlocks(ctx)).toEqual([]);
  });

  it('a token from another format conflicts', async () => {
    servePng(REAL_PNG_13x7);
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await expect(
      clipboardRead.handler(
        clipboardRead.input.parse({ format: 'auto', offset: 0, representationId: 'text:png-rev' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'representation_changed' } });
  });

  it('an empty representationId from a form-based client is treated as absent', async () => {
    servePng(REAL_PNG_13x7);
    const { result } = await readBothSurfaces({
      format: 'image',
      offset: 0,
      limit: 7,
      representationId: '',
    });
    expect(result.byteSize).toBe(7);
  });

  it('maps a mid-read change the backend reports, keeping its platform', async () => {
    const svc = mockService({
      read: Promise.reject(
        clipboardOutcome('macOS', 'The clipboard changed while its Text was being read.', {
          category: 'representation_changed',
        }),
      ),
    });
    mockGetService.mockReturnValueOnce(svc);
    const ctx = createMockContext({ errors: clipboardRead.errors });
    await expect(
      clipboardRead.handler(clipboardRead.input.parse({ format: 'text' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      message: expect.stringContaining('changed while its Text was being read'),
      data: {
        reason: 'representation_changed',
        platform: 'macOS',
        recovery: { hint: RECOVERY },
      },
    });
  });

  it('the input and output descriptions explain the continuation contract', () => {
    expect(clipboardRead.input.shape.representationId.description).toMatch(
      /previous slice's representationId/,
    );
    expect(clipboardRead.input.shape.representationId.description).toMatch(
      /representation_changed/,
    );
    expect(clipboardRead.output.shape.representationId.description).toMatch(
      /Equal across full and sliced reads of an unchanged value/,
    );
    expect(clipboardRead.description).toMatch(/representationId/);
  });
});
