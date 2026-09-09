/**
 * @fileoverview Tests for clipboard_read tool.
 * @module tests/tools/clipboard-read.tool.test
 */

import { createMockContext, getContentBlocks } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboardRead } from '@/mcp-server/tools/definitions/clipboard-read.tool.js';
import { SIZE_LIMITS } from '@/services/clipboard/clipboard-service.js';

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

/** Shape a bare backend-style result the way ClipboardService.read() returns it: one complete slice. */
function asRangedRead<T extends { content: Buffer }>(r: T) {
  return {
    byteSize: r.content.byteLength,
    totalByteSize: r.content.byteLength,
    complete: true,
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
    it('throws format_unavailable when backend says not found', async () => {
      const svc = mockService({
        read: Promise.reject(new Error('HTML format not found on clipboard')),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'html' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'format_unavailable' },
      });
    });

    it('throws format_unavailable for text when backend says not found (empty clipboard)', async () => {
      // Backend throws "text format not found" when clipboard has no text type
      const svc = mockService({
        read: Promise.reject(new Error('text format not found on clipboard')),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'text' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'format_unavailable' },
      });
    });

    it('throws format_unavailable for rtf when backend returns null (no RTF on clipboard)', async () => {
      // Backend throws "RTF format not found" when public.rtf is absent
      const svc = mockService({
        read: Promise.reject(new Error('RTF format not found on clipboard')),
      });
      mockGetService.mockReturnValueOnce(svc);

      const ctx = createMockContext({ errors: clipboardRead.errors });
      const input = clipboardRead.input.parse({ format: 'rtf' });
      await expect(clipboardRead.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'format_unavailable' },
      });
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
        read: Promise.reject(new Error('RTF format not found on clipboard')),
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
        .mockResolvedValueOnce({ format: 'image' as const, content: png, width: 8, height: 6 }),
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
      read: Promise.reject(new Error('Image format not found on clipboard')),
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
    });
    const text = clipboardRead.format!(result).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('23 of 4,096 bytes');
    expect(text).toContain('**Complete:** false');
    expect(text).toContain('**Next offset:** 512');
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

  it('content_too_large recovery points at offset/limit', () => {
    const entry = clipboardRead.errors?.find((e) => e.reason === 'content_too_large');
    expect(entry?.recovery).toMatch(/offset/);
    expect(entry?.recovery).toMatch(/limit/);
    expect(entry?.recovery).toMatch(/nextOffset/);
  });
});
