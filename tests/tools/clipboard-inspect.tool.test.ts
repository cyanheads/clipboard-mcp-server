/**
 * @fileoverview Tests for clipboard_inspect tool.
 * @module tests/tools/clipboard-inspect.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboardInspect } from '@/mcp-server/tools/definitions/clipboard-inspect.tool.js';
import { inspectUnreadable } from '@/services/clipboard/types.js';

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
    const output = { primaryFormat: 'empty' as const, availableFormats: [], rawTypes: [] };
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
  });
});
