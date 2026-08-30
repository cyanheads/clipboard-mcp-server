/**
 * @fileoverview Tests for clipboard_read tool.
 * @module tests/tools/clipboard-read.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

/** Build a mock ClipboardService with inspect and read. */
function mockService(opts: {
  inspect?: ReturnType<ReturnType<typeof getClipboardService>['inspect']>;
  read?: ReturnType<ReturnType<typeof getClipboardService>['read']>;
}) {
  return {
    inspect: opts.inspect ? vi.fn().mockReturnValue(opts.inspect) : vi.fn(),
    read: opts.read ? vi.fn().mockReturnValue(opts.read) : vi.fn(),
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
      const output = { format: 'text' as const, content: 'hello world', byteSize: 11 };
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
