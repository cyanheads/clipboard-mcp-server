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
    it('rejects an empty write and points at the clear mode instead', () => {
      expect(() => clipboardWrite.input.parse({ content: '', format: 'text' })).toThrow(
        /clear: true/,
      );
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

describe('clipboardWrite — response-surface characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the service result unchanged', async () => {
    const writeMock = vi.fn().mockResolvedValueOnce({ format: 'html' as const, byteSize: 12 });
    mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
      typeof getClipboardService
    >);

    const ctx = createMockContext({ errors: clipboardWrite.errors });
    const input = clipboardWrite.input.parse({ content: '<p>Hello</p>', format: 'html' });
    await expect(clipboardWrite.handler(input, ctx)).resolves.toEqual({
      format: 'html',
      byteSize: 12,
    });
  });

  it('rethrows an unrecognized backend failure unchanged', async () => {
    const writeMock = vi.fn().mockRejectedValueOnce(new Error('pbcopy exited 1'));
    mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
      typeof getClipboardService
    >);

    const ctx = createMockContext({ errors: clipboardWrite.errors });
    const input = clipboardWrite.input.parse({ content: 'x', format: 'text' });
    await expect(clipboardWrite.handler(input, ctx)).rejects.toThrow('pbcopy exited 1');
  });

  it('format() emits exactly one text block carrying the format and size labels', () => {
    const blocks = clipboardWrite.format!({ format: 'text', byteSize: 1234 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const text = blocks[0]?.type === 'text' ? blocks[0].text : '';
    expect(text).toContain('**Format written:** text');
    expect(text).toContain('1,234');
  });
});

describe('clipboardWrite — previous clipboard contents (#28)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns previousContent supplied by the service', async () => {
    const writeMock = vi.fn().mockResolvedValueOnce({
      format: 'text' as const,
      byteSize: 3,
      previousContent: 'the old note',
    });
    mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
      typeof getClipboardService
    >);

    const ctx = createMockContext({ errors: clipboardWrite.errors });
    const input = clipboardWrite.input.parse({ content: 'new', format: 'text' });
    const result = await clipboardWrite.handler(input, ctx);

    expect(result.previousContent).toBe('the old note');
  });

  it('omits previousContent when the service reports none', async () => {
    const writeMock = vi.fn().mockResolvedValueOnce({ format: 'text' as const, byteSize: 3 });
    mockGetService.mockReturnValueOnce({ write: writeMock } as ReturnType<
      typeof getClipboardService
    >);

    const ctx = createMockContext({ errors: clipboardWrite.errors });
    const input = clipboardWrite.input.parse({ content: 'new', format: 'text' });
    const result = await clipboardWrite.handler(input, ctx);

    expect(result).not.toHaveProperty('previousContent');
  });

  it('declares previousContent as an optional string on the output schema', () => {
    const parsed = clipboardWrite.output.parse({ format: 'text', byteSize: 1 });
    expect(parsed).not.toHaveProperty('previousContent');
    expect(
      clipboardWrite.output.parse({ format: 'text', byteSize: 1, previousContent: 'x' }),
    ).toMatchObject({
      previousContent: 'x',
    });
  });

  describe('format()', () => {
    function render(previousContent?: string): string {
      const blocks = clipboardWrite.format!({
        format: 'text',
        byteSize: 3,
        ...(previousContent !== undefined && { previousContent }),
      });
      return blocks.find((b) => b.type === 'text')?.text ?? '';
    }

    it('renders the previous contents when present', () => {
      const text = render('the old note');
      expect(text).toContain('the old note');
      expect(text.toLowerCase()).toContain('previous');
    });

    it('omits the previous-contents line cleanly when absent', () => {
      const text = render();
      expect(text.toLowerCase()).not.toContain('previous');
      expect(text.trimEnd()).toBe(text);
    });

    it('fences prior contents so markdown metacharacters cannot control rendering', () => {
      const prior = 'a ``` fence | *emphasis* <b>tag</b>';
      const text = render(prior);
      const match = /(`{3,})[^\n]*\n([\s\S]*)\n\1/.exec(text);
      expect(match?.[2]).toBe(prior);
      expect(match![1]!.length).toBeGreaterThan(3);
    });
  });
});

describe('clipboardWrite — explicit clear (#24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function serviceWithClear(result: Record<string, unknown>) {
    const clearMock = vi.fn().mockResolvedValueOnce(result);
    const writeMock = vi.fn();
    mockGetService.mockReturnValueOnce({
      clear: clearMock,
      write: writeMock,
    } as unknown as ReturnType<typeof getClipboardService>);
    return { clearMock, writeMock };
  }

  describe('input schema', () => {
    it('accepts clear: true with no content', () => {
      expect(clipboardWrite.input.parse({ clear: true })).toMatchObject({ clear: true });
    });

    it('leaves an ordinary write unchanged', () => {
      expect(clipboardWrite.input.parse({ content: 'hello' })).toEqual({
        content: 'hello',
        format: 'text',
        clear: false,
      });
    });

    it.each([
      ['neither content nor clear', {}],
      ['an empty content string', { content: '' }],
      ['an empty content string with clear: false', { content: '', clear: false }],
      ['content with clear omitted but blank', { content: '', format: 'html' }],
    ])('rejects %s with guidance naming clear: true', (_label, args) => {
      expect(() => clipboardWrite.input.parse(args)).toThrow(/clear: true/);
    });

    it.each([
      ['content alongside clear: true', { content: 'ignored', clear: true }],
      ['html content alongside clear: true', { content: '<b>x</b>', format: 'html', clear: true }],
    ])('rejects %s rather than silently discarding the content', (_label, args) => {
      expect(() => clipboardWrite.input.parse(args)).toThrow(/not both|only one/i);
    });

    it('describes the clear mode on the tool and the field', () => {
      expect(clipboardWrite.description).toContain('clear');
      expect(clipboardWrite.input.shape.clear.description).toContain('clear');
      expect(clipboardWrite.input.shape.content.description).toContain('clear');
    });
  });

  describe('handler', () => {
    it('clears the clipboard and reports a zero-byte cleared result', async () => {
      const { clearMock, writeMock } = serviceWithClear({ byteSize: 0, cleared: true });

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const result = await clipboardWrite.handler(clipboardWrite.input.parse({ clear: true }), ctx);

      expect(result).toEqual({ byteSize: 0, cleared: true });
      expect(clearMock).toHaveBeenCalledWith(ctx);
      expect(writeMock).not.toHaveBeenCalled();
    });

    it('returns previousContent captured before the clear', async () => {
      serviceWithClear({ byteSize: 0, cleared: true, previousContent: 'the old note' });

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      const result = await clipboardWrite.handler(clipboardWrite.input.parse({ clear: true }), ctx);

      expect(result.previousContent).toBe('the old note');
    });

    it('refuses an empty write reaching the handler unvalidated', async () => {
      mockGetService.mockReturnValueOnce({ write: vi.fn() } as unknown as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      await expect(
        clipboardWrite.handler({ clear: false, format: 'text' } as never, ctx),
      ).rejects.toThrow(/clear: true/);
    });

    it('propagates a backend clear failure', async () => {
      const clearMock = vi.fn().mockRejectedValueOnce(new Error('xsel exited 1'));
      mockGetService.mockReturnValueOnce({ clear: clearMock } as unknown as ReturnType<
        typeof getClipboardService
      >);

      const ctx = createMockContext({ errors: clipboardWrite.errors });
      await expect(
        clipboardWrite.handler(clipboardWrite.input.parse({ clear: true }), ctx),
      ).rejects.toThrow('xsel exited 1');
    });
  });

  describe('output schema', () => {
    it('accepts a cleared result with no format', () => {
      expect(clipboardWrite.output.parse({ byteSize: 0, cleared: true })).toEqual({
        byteSize: 0,
        cleared: true,
      });
    });

    it('still accepts an ordinary write result', () => {
      expect(clipboardWrite.output.parse({ format: 'text', byteSize: 5 })).toEqual({
        format: 'text',
        byteSize: 5,
      });
    });
  });

  describe('format()', () => {
    function render(output: Parameters<NonNullable<typeof clipboardWrite.format>>[0]): string {
      return clipboardWrite.format!(output).find((b) => b.type === 'text')?.text ?? '';
    }

    it('renders the cleared case without claiming a format was written', () => {
      const text = render({ byteSize: 0, cleared: true });
      expect(text).toContain('true');
      expect(text.toLowerCase()).toContain('cleared');
      expect(text).not.toMatch(/\*\*Format written:\*\* (text|html)/);
    });

    it('renders the prior contents alongside a clear', () => {
      const text = render({ byteSize: 0, cleared: true, previousContent: 'the old note' });
      expect(text).toContain('the old note');
      expect(text.toLowerCase()).toContain('previous');
    });

    it('leaves an ordinary write rendering unchanged', () => {
      const text = render({ format: 'text', byteSize: 1234 });
      expect(text).toContain('**Format written:** text');
      expect(text).toContain('1,234');
      expect(text.toLowerCase()).not.toContain('cleared');
    });
  });
});
