/**
 * @fileoverview Tests for clipboard_write tool.
 * @module tests/tools/clipboard-write.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboardWrite } from '@/mcp-server/tools/definitions/clipboard-write.tool.js';
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

describe('clipboardWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('qualifies the HTML plain-text fallback as a macOS and Windows capability', () => {
    expect(clipboardWrite.description).toContain('macOS and Windows');
    expect(clipboardWrite.description).toContain('Linux X11 and Wayland publish only text/html');
    expect(clipboardWrite.input.shape.format.description).toContain('macOS and Windows');
    expect(clipboardWrite.input.shape.format.description).toContain(
      'Linux X11 and Wayland publish only text/html',
    );
  });

  describe('write text', () => {
    it('writes plain text and returns byteSize', async () => {
      const writeMock = vi.fn().mockResolvedValueOnce({ format: 'text' as const, byteSize: 11 });
      mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const input = clipboardWrite.input.parse({ content: 'hello world', format: 'text' });
      const result = await clipboardWrite.handler(input, ctx);
      expect(result.format).toBe('text');
      expect(result.byteSize).toBe(11);
    });

    it('uses "text" as default format', async () => {
      const writeMock = vi.fn().mockResolvedValueOnce({ format: 'text' as const, byteSize: 5 });
      mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      // Omit format — should default to "text"
      const input = clipboardWrite.input.parse({ content: 'hello' });
      const result = await clipboardWrite.handler(input, ctx);
      expect(result.format).toBe('text');
    });

    it('writes unicode and emoji correctly', async () => {
      const text = 'Hello 世界 🌍';
      const bytes = Buffer.byteLength(text, 'utf8');
      const writeMock = vi.fn().mockResolvedValueOnce({ format: 'text' as const, byteSize: bytes });
      mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const input = clipboardWrite.input.parse({ content: text, format: 'text' });
      const result = await clipboardWrite.handler(input, ctx);
      expect(result.byteSize).toBe(bytes);
      expect(writeMock).toHaveBeenCalledWith(text, 'text', ctx);
    });
  });

  describe('write html', () => {
    it('writes HTML and returns correct format and byteSize', async () => {
      const html = '<html><body><b>Test</b></body></html>';
      const bytes = Buffer.byteLength(html, 'utf8');
      const writeMock = vi.fn().mockResolvedValueOnce({ format: 'html' as const, byteSize: bytes });
      mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const input = clipboardWrite.input.parse({ content: html, format: 'html' });
      const result = await clipboardWrite.handler(input, ctx);
      expect(result.format).toBe('html');
      expect(result.byteSize).toBe(bytes);
    });

    it('writes HTML with special chars including script tags', async () => {
      const html = '<html><body><script>alert(1)</script></body></html>';
      const bytes = Buffer.byteLength(html, 'utf8');
      const writeMock = vi.fn().mockResolvedValueOnce({ format: 'html' as const, byteSize: bytes });
      mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const input = clipboardWrite.input.parse({ content: html, format: 'html' });
      const result = await clipboardWrite.handler(input, ctx);
      expect(result.byteSize).toBe(bytes);
      // Service is called with raw content — service handles safe passing to subprocess
      expect(writeMock).toHaveBeenCalledWith(html, 'html', ctx);
    });
  });

  describe('error: content_too_large', () => {
    it('throws content_too_large when service signals size exceeded', async () => {
      const oversized = Object.assign(new Error('content_too_large'), {
        _contentTooLarge: true,
        bytes: SIZE_LIMITS.WRITE + 1,
        limit: SIZE_LIMITS.WRITE,
      });
      const writeMock = vi.fn().mockRejectedValueOnce(oversized);
      mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const input = clipboardWrite.input.parse({ content: 'x', format: 'text' });
      await expect(clipboardWrite.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'content_too_large', bytes: SIZE_LIMITS.WRITE + 1 },
      });
    });
  });

  describe('edge cases', () => {
    it('writes empty string without error', async () => {
      const writeMock = vi.fn().mockResolvedValueOnce({ format: 'text' as const, byteSize: 0 });
      mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const input = clipboardWrite.input.parse({ content: '', format: 'text' });
      const result = await clipboardWrite.handler(input, ctx);
      expect(result.byteSize).toBe(0);
    });

    it('handles content with injection-like chars (service owns safety)', async () => {
      const payload = '"; $(whoami); "';
      const writeMock = vi.fn().mockResolvedValueOnce({
        format: 'text' as const,
        byteSize: Buffer.byteLength(payload, 'utf8'),
      });
      mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const input = clipboardWrite.input.parse({ content: payload, format: 'text' });
      const result = await clipboardWrite.handler(input, ctx);
      expect(result.format).toBe('text');
      // The service receives the raw payload — it's responsible for safe subprocess passing
      expect(writeMock).toHaveBeenCalledWith(payload, 'text', ctx);
    });
  });

  describe('format()', () => {
    it('renders format and byteSize', () => {
      const output = { format: 'text' as const, byteSize: 42 };
      const blocks = clipboardWrite.format!(output);
      const text = blocks.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain('text');
      expect(text).toContain('42');
    });

    it('renders html format with byteSize', () => {
      const output = { format: 'html' as const, byteSize: 512 };
      const blocks = clipboardWrite.format!(output);
      const text = blocks.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain('html');
      expect(text).toContain('512');
    });
  });
});
