/**
 * @fileoverview Wire-level outcomes of the clipboard tools against modeled
 * native helpers. Only `child_process.spawn` is faked: each tool runs through
 * `runToolContract` over the real ClipboardService and the real platform
 * backend, so the helper-output classification, the service, and the tool's
 * reason mapping are all under test. Helper diagnostics are the verbatim
 * spellings captured from wl-clipboard 2.1.0 / 2.2.1, xclip 0.13 and xclip
 * git builds.
 * @module tests/tools/native-outcomes.test
 */

import { createHash } from 'node:crypto';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('@/services/clipboard/clipboard-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/clipboard/clipboard-service.js')>();
  return { ...actual, getClipboardService: vi.fn(), initClipboardService: vi.fn() };
});

import { spawn } from 'node:child_process';
import { clipboardInspect } from '@/mcp-server/tools/definitions/clipboard-inspect.tool.js';
import { clipboardRead } from '@/mcp-server/tools/definitions/clipboard-read.tool.js';
import { clipboardWrite } from '@/mcp-server/tools/definitions/clipboard-write.tool.js';
import { buildCfHtml } from '@/services/clipboard/cf-html.js';
import { ClipboardService, getClipboardService } from '@/services/clipboard/clipboard-service.js';
import { LinuxWaylandBackend } from '@/services/clipboard/linux-wayland-backend.js';
import { LinuxX11Backend } from '@/services/clipboard/linux-x11-backend.js';
import { MacosBackend } from '@/services/clipboard/macos-backend.js';
import type { ClipboardBackend } from '@/services/clipboard/types.js';
import { WindowsBackend } from '@/services/clipboard/windows-backend.js';
import {
  type HelperScript,
  requestedType,
  scriptedSpawn,
} from '../services/clipboard/scripted-spawn.js';

const mockSpawn = vi.mocked(spawn);
const mockGetService = vi.mocked(getClipboardService);

const ServiceUnavailable = -32000;
const NotFound = -32001;

/** Route helper spawns through `script` and serve the tools from `backend`. */
function install(backend: ClipboardBackend, script: HelperScript) {
  const fake = scriptedSpawn(script);
  mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
  mockGetService.mockReturnValue(new ClipboardService(backend));
  return fake;
}

/** The `structuredContent.error` envelope of a failed call. */
function wireError(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { code: number; data?: Record<string, unknown> } })
    .error;
}

/** Recovery hint on the wire, from `data.recovery.hint`. */
function hintOf(error: { data?: Record<string, unknown> }): string {
  return String((error.data?.recovery as { hint?: unknown } | undefined)?.hint ?? '');
}

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// X11 model: xclip -o / -i and xsel --clear.
// ---------------------------------------------------------------------------

type XclipVersion = '0.13' | 'git';

interface X11World {
  /** Helper binaries missing from PATH. */
  missing?: readonly string[];
  /** Display unreachable (value printed in xclip's diagnostic). */
  noDisplay?: string;
  /**
   * Selection owner. `xclip` answers every requested target with its one
   * buffer; `xsel` (a strict owner) converts only the targets it offers.
   */
  owner?: { kind: 'xclip' | 'xsel'; types: Record<string, Buffer | string> };
  version: XclipVersion;
}

function x11Script(world: X11World): HelperScript {
  return (command, args) => {
    if (world.missing?.includes(command)) return { errorCode: 'ENOENT' };
    if (command === 'xsel') {
      if (world.noDisplay !== undefined) {
        return { exitCode: 1, stderr: "xsel: Can't open display: (null)\n: Connection refused" };
      }
      return {};
    }
    const prefix = world.version === 'git' ? 'xclip: ' : '';
    if (world.noDisplay !== undefined) {
      return { exitCode: 1, stderr: `${prefix}Error: Can't open display: ${world.noDisplay}` };
    }
    if (args.includes('-i')) return { forks: true };
    const target = requestedType(args) ?? 'UTF8_STRING';
    const owner = world.owner;
    if (!owner) {
      if (world.version === 'git') {
        return {
          exitCode: 1,
          stderr: 'xclip: Error: There is no owner for the CLIPBOARD selection',
        };
      }
      const printed = target === 'UTF8_STRING' ? 'STRING' : target;
      return { exitCode: 1, stderr: `Error: target ${printed} not available` };
    }
    const offered = Object.keys(owner.types);
    if (target === 'TARGETS') {
      const listing =
        owner.kind === 'xclip' ? ['TARGETS', ...offered] : ['TIMESTAMP', 'TARGETS', ...offered];
      return { stdout: `${listing.join('\n')}\n` };
    }
    if (owner.kind === 'xclip') {
      // xclip serves its single buffer for any target a requestor names.
      return { stdout: Object.values(owner.types)[0] ?? '' };
    }
    const value = owner.types[target];
    if (value !== undefined) return { stdout: value };
    return world.version === 'git'
      ? {
          exitCode: 1,
          stderr: `xclip: Error: 'xsel' (0x400001) cannot convert CLIPBOARD selection to target '${target}'`,
        }
      : { exitCode: 1, stderr: `Error: target ${target} not available` };
  };
}

// ---------------------------------------------------------------------------
// Wayland model: wl-paste / wl-copy.
// ---------------------------------------------------------------------------

type WlVersion = '2.1' | '2.2';

interface WaylandWorld {
  missing?: readonly string[];
  noCompositor?: boolean;
  /** Offered MIME types and their exact bytes; undefined = nothing copied. */
  types?: Record<string, Buffer | string>;
  version: WlVersion;
}

/** wl-paste's own notion of a textual type — it appends "\n" to these unless told not to. */
function wlTreatsAsText(type: string): boolean {
  return type.startsWith('text/') || ['TEXT', 'STRING', 'UTF8_STRING'].includes(type);
}

function waylandScript(world: WaylandWorld): HelperScript {
  const noCompositor =
    world.version === '2.2'
      ? 'Failed to connect to a Wayland server: No such file or directory\n' +
        'Note: WAYLAND_DISPLAY is set to wayland-9\n' +
        'Note: XDG_RUNTIME_DIR is set to /tmp/xdg\n' +
        'Please check whether /tmp/xdg/wayland-9 socket exists and is accessible.'
      : 'Failed to connect to a Wayland server';
  return (command, args) => {
    if (world.missing?.includes(command)) return { errorCode: 'ENOENT' };
    if (world.noCompositor) return { exitCode: 1, stderr: noCompositor };
    if (command === 'wl-copy') return { forks: true };
    const types = world.types;
    if (!types) {
      return {
        exitCode: 1,
        stderr: world.version === '2.2' ? 'Nothing is copied' : 'No selection',
      };
    }
    if (args.includes('--list-types') || args.includes('-l')) {
      return { stdout: `${Object.keys(types).join('\n')}\n` };
    }
    const type = requestedType(args) ?? 'text/plain';
    const value = types[type];
    if (value === undefined) {
      return {
        exitCode: 1,
        stderr:
          world.version === '2.2'
            ? `Clipboard content is not available as requested type "${type}"\nUse "wl-paste --list-types" to view available types.`
            : 'No suitable type of content copied',
      };
    }
    const noNewline = args.includes('--no-newline') || args.includes('-n');
    const bytes = Buffer.from(value);
    return {
      stdout:
        !noNewline && wlTreatsAsText(type) ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes,
    };
  };
}

/** The five text aliases wl-copy offers alongside any textual type it copies. */
function wlTextOffer(value: string, primary = 'text/plain'): Record<string, string> {
  const offer: Record<string, string> = { [primary]: value };
  for (const alias of ['text/plain', 'text/plain;charset=utf-8', 'TEXT', 'STRING', 'UTF8_STRING']) {
    offer[alias] = value;
  }
  return offer;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Characterization — behavior that holds before and after the typed outcomes.
// ---------------------------------------------------------------------------

describe('characterization: current behavior kept', () => {
  it('X11: a strict owner offering text reads back its exact bytes', async () => {
    install(
      new LinuxX11Backend(),
      x11Script({ version: '0.13', owner: { kind: 'xsel', types: { UTF8_STRING: 'abc\n' } } }),
    );
    const result = await runToolContract(clipboardRead, { format: 'text' });
    expect(result.structuredContent).toMatchObject({
      format: 'text',
      content: 'abc\n',
      totalByteSize: 4,
    });
  });

  it('Wayland: image/png bytes pass through unaltered', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x58]);
    install(
      new LinuxWaylandBackend(),
      waylandScript({ version: '2.2', types: { 'image/png': png } }),
    );
    const result = await runToolContract(clipboardRead, { format: 'image' });
    expect(result.structuredContent).toMatchObject({
      format: 'image',
      content: png.toString('base64'),
      totalByteSize: png.byteLength,
    });
  });

  it.each([
    ['X11', () => new LinuxX11Backend(), 'xclip'],
    ['Wayland', () => new LinuxWaylandBackend(), 'wl-paste'],
  ] as const)(
    '%s: an unrecognized helper failure on a listed type still fails',
    async (_label, make, helper) => {
      install(make(), (command, args) => {
        if (args.includes('TARGETS')) return { stdout: 'TARGETS\ntext/html\n' };
        if (args.includes('--list-types')) return { stdout: 'text/html\n' };
        return { exitCode: 1, stderr: `${command}: Error: BadAlloc (insufficient resources)` };
      });
      const result = await runToolContract(clipboardRead, { format: 'html' });
      const error = wireError(result);
      expect(error.data?.reason).toBeUndefined();
      expect(
        String((result.structuredContent as { error: { message: string } }).error.message),
      ).toContain(`${helper} exited 1`);
    },
  );
});

// ---------------------------------------------------------------------------
// #36 — typed outcomes on X11, both xclip generations.
// ---------------------------------------------------------------------------

describe.each(['0.13', 'git'] as const)('X11, xclip %s', (version) => {
  it('empty clipboard: inspect reports empty; explicit and auto reads fail format_unavailable', async () => {
    install(new LinuxX11Backend(), x11Script({ version }));

    const inspect = await runToolContract(clipboardInspect, {});
    expect(inspect.isError).toBeFalsy();
    expect(inspect.structuredContent).toEqual({
      primaryFormat: 'empty',
      availableFormats: [],
      rawTypes: [],
    });

    for (const format of ['text', 'auto', 'html', 'rtf', 'image'] as const) {
      const error = wireError(await runToolContract(clipboardRead, { format }));
      expect(error, format).toMatchObject({
        code: NotFound,
        data: { reason: 'format_unavailable' },
      });
      expect(hintOf(error)).toMatch(/clipboard_inspect/);
    }
  });

  it('a strict owner without HTML: reading html fails format_unavailable', async () => {
    install(
      new LinuxX11Backend(),
      x11Script({ version, owner: { kind: 'xsel', types: { UTF8_STRING: 'abc', STRING: 'abc' } } }),
    );
    const error = wireError(await runToolContract(clipboardRead, { format: 'html' }));
    expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
  });

  it.each(['html', 'rtf', 'image'] as const)(
    'an xclip-owned text selection: reading %s fails format_unavailable instead of returning the text',
    async (format) => {
      install(
        new LinuxX11Backend(),
        x11Script({ version, owner: { kind: 'xclip', types: { UTF8_STRING: 'abc' } } }),
      );
      const result = await runToolContract(clipboardRead, { format });
      const error = wireError(result);
      expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
      expect(result.content.some((b) => b.type === 'image')).toBe(false);
    },
  );

  it('an xclip-owned text selection still reads as text', async () => {
    install(
      new LinuxX11Backend(),
      x11Script({ version, owner: { kind: 'xclip', types: { UTF8_STRING: 'abc' } } }),
    );
    const result = await runToolContract(clipboardRead, { format: 'text' });
    expect(result.structuredContent).toMatchObject({
      format: 'text',
      content: 'abc',
      totalByteSize: 3,
    });
  });

  it('a zero-byte text/html is present: html and auto reads succeed with totalByteSize 0', async () => {
    install(
      new LinuxX11Backend(),
      x11Script({ version, owner: { kind: 'xclip', types: { 'text/html': '' } } }),
    );

    const inspect = await runToolContract(clipboardInspect, {});
    expect(inspect.structuredContent).toMatchObject({
      primaryFormat: 'html',
      rawTypes: [
        { type: 'TARGETS', bytes: 0 },
        { type: 'text/html', bytes: 0 },
      ],
    });

    for (const format of ['html', 'auto'] as const) {
      const result = await runToolContract(clipboardRead, { format });
      expect(result.isError, format).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        format: 'html',
        content: '',
        byteSize: 0,
        totalByteSize: 0,
        complete: true,
      });
      expect(textOf(result)).toContain('0 of 0 bytes');
    }
  });

  it.each(['text', 'rtf'] as const)(
    'a zero-byte %s representation reads as an empty success',
    async (format) => {
      const type = format === 'text' ? 'UTF8_STRING' : 'text/rtf';
      install(
        new LinuxX11Backend(),
        x11Script({ version, owner: { kind: 'xsel', types: { [type]: '' } } }),
      );
      const result = await runToolContract(clipboardRead, { format });
      expect(result.structuredContent).toMatchObject({
        format,
        content: '',
        totalByteSize: 0,
        complete: true,
      });
    },
  );

  it('a zero-byte image/png succeeds with empty content and no image block', async () => {
    install(
      new LinuxX11Backend(),
      x11Script({ version, owner: { kind: 'xclip', types: { 'image/png': '' } } }),
    );
    for (const format of ['image', 'auto'] as const) {
      const result = await runToolContract(clipboardRead, { format });
      expect(result.isError, format).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        format: 'image',
        content: '',
        totalByteSize: 0,
      });
      expect(result.content.some((b) => b.type === 'image')).toBe(false);
    }
  });

  it('no reachable display: every tool fails clipboard_unavailable naming DISPLAY', async () => {
    install(new LinuxX11Backend(), x11Script({ version, noDisplay: ':98' }));
    const calls = [
      () => runToolContract(clipboardInspect, {}),
      () => runToolContract(clipboardRead, { format: 'text' }),
      () => runToolContract(clipboardRead, { format: 'html' }),
      () => runToolContract(clipboardRead, { format: 'auto' }),
      () => runToolContract(clipboardWrite, { content: 'abc' }),
      () => runToolContract(clipboardWrite, { clear: true }),
    ];
    for (const call of calls) {
      const error = wireError(await call());
      expect(error).toMatchObject({
        code: ServiceUnavailable,
        data: { reason: 'clipboard_unavailable' },
      });
      expect(hintOf(error)).toMatch(/DISPLAY/);
    }
  });
});

describe('X11 helpers missing from PATH', () => {
  it('xclip missing: reads, inspect, and write fail clipboard_unavailable with the install command', async () => {
    install(new LinuxX11Backend(), x11Script({ version: '0.13', missing: ['xclip'] }));
    const calls = [
      () => runToolContract(clipboardInspect, {}),
      () => runToolContract(clipboardRead, { format: 'text' }),
      () => runToolContract(clipboardRead, { format: 'html' }),
      () => runToolContract(clipboardRead, { format: 'auto' }),
      () => runToolContract(clipboardWrite, { content: 'abc', format: 'html' }),
    ];
    for (const call of calls) {
      const result = await call();
      const error = wireError(result);
      expect(error).toMatchObject({
        code: ServiceUnavailable,
        data: { reason: 'clipboard_unavailable' },
      });
      expect(hintOf(error)).toMatch(/apt install xclip/);
      expect(textOf(result)).toMatch(/apt install xclip/);
    }
  });

  it('xsel missing: clear fails clipboard_unavailable with the xsel install command', async () => {
    install(
      new LinuxX11Backend(),
      x11Script({
        version: '0.13',
        missing: ['xsel'],
        owner: { kind: 'xclip', types: { UTF8_STRING: 'x' } },
      }),
    );
    const error = wireError(await runToolContract(clipboardWrite, { clear: true }));
    expect(error).toMatchObject({
      code: ServiceUnavailable,
      data: { reason: 'clipboard_unavailable' },
    });
    expect(hintOf(error)).toMatch(/apt install xsel/);
  });
});

// ---------------------------------------------------------------------------
// #40 — X11 write resolves once xclip owns the selection.
// ---------------------------------------------------------------------------

describe('X11 clipboard_write while the forked xclip keeps serving', () => {
  it.each(['text', 'html'] as const)(
    'a %s write resolves on the foreground exit',
    async (format) => {
      const fake = install(
        new LinuxX11Backend(),
        x11Script({ version: '0.13', owner: { kind: 'xsel', types: { UTF8_STRING: 'old' } } }),
      );
      const outcome = await Promise.race([
        runToolContract(clipboardWrite, { content: '<b>hi</b>', format }).then((r) => r),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 500)),
      ]);
      expect(outcome).not.toBe('pending');
      if (outcome === 'pending') return;
      expect(outcome.structuredContent).toMatchObject({
        format,
        byteSize: 9,
        previousContent: 'old',
      });
      const input = fake.calls.find((c) => c.args.includes('-i'));
      expect(input?.stdin?.toString('utf8')).toBe('<b>hi</b>');
    },
  );
});

// ---------------------------------------------------------------------------
// #36 + #35 — Wayland, both wl-paste generations.
// ---------------------------------------------------------------------------

describe.each(['2.1', '2.2'] as const)('Wayland, wl-clipboard %s', (version) => {
  it('empty clipboard: inspect reports empty; explicit and auto reads fail format_unavailable', async () => {
    install(new LinuxWaylandBackend(), waylandScript({ version }));

    const inspect = await runToolContract(clipboardInspect, {});
    expect(inspect.isError).toBeFalsy();
    expect(inspect.structuredContent).toEqual({
      primaryFormat: 'empty',
      availableFormats: [],
      rawTypes: [],
    });

    for (const format of ['text', 'auto', 'html', 'rtf', 'image'] as const) {
      const error = wireError(await runToolContract(clipboardRead, { format }));
      expect(error, format).toMatchObject({
        code: NotFound,
        data: { reason: 'format_unavailable' },
      });
    }
  });

  it.each(['html', 'rtf', 'image'] as const)(
    'text only: reading %s fails format_unavailable',
    async (format) => {
      install(new LinuxWaylandBackend(), waylandScript({ version, types: wlTextOffer('abc') }));
      const error = wireError(await runToolContract(clipboardRead, { format }));
      expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
    },
  );

  it('"abc" reads back as exactly 3 bytes, and inspect counts 3 for every text alias (#35)', async () => {
    install(new LinuxWaylandBackend(), waylandScript({ version, types: wlTextOffer('abc') }));

    const read = await runToolContract(clipboardRead, { format: 'text' });
    expect(read.structuredContent).toMatchObject({ content: 'abc', byteSize: 3, totalByteSize: 3 });

    const inspect = await runToolContract(clipboardInspect, {});
    const rawTypes = (inspect.structuredContent as { rawTypes: { bytes?: number }[] }).rawTypes;
    expect(rawTypes).toHaveLength(5);
    for (const entry of rawTypes) expect(entry.bytes).toBe(3);
  });

  it('a trailing newline already on the clipboard is preserved (#35)', async () => {
    install(new LinuxWaylandBackend(), waylandScript({ version, types: wlTextOffer('abc\n') }));
    const read = await runToolContract(clipboardRead, { format: 'text' });
    expect(read.structuredContent).toMatchObject({ content: 'abc\n', totalByteSize: 4 });
  });

  it('HTML reads back as its 9 written bytes (#35)', async () => {
    install(
      new LinuxWaylandBackend(),
      waylandScript({ version, types: wlTextOffer('<b>hi</b>', 'text/html') }),
    );
    const read = await runToolContract(clipboardRead, { format: 'html' });
    expect(read.structuredContent).toMatchObject({
      format: 'html',
      content: '<b>hi</b>',
      totalByteSize: 9,
    });
  });

  it('an empty text/plain reads back as "" with totalByteSize 0 (#35)', async () => {
    install(new LinuxWaylandBackend(), waylandScript({ version, types: wlTextOffer('') }));
    const read = await runToolContract(clipboardRead, { format: 'text' });
    expect(read.structuredContent).toMatchObject({ content: '', totalByteSize: 0, complete: true });
  });

  it('a zero-byte text/html is present: html and auto reads succeed with totalByteSize 0', async () => {
    install(
      new LinuxWaylandBackend(),
      waylandScript({ version, types: wlTextOffer('', 'text/html') }),
    );
    for (const format of ['html', 'auto'] as const) {
      const result = await runToolContract(clipboardRead, { format });
      expect(result.isError, format).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        format: 'html',
        content: '',
        totalByteSize: 0,
      });
    }
  });

  it('a zero-byte application/rtf reads as an empty rtf success', async () => {
    install(
      new LinuxWaylandBackend(),
      waylandScript({ version, types: { 'application/rtf': '' } }),
    );
    const result = await runToolContract(clipboardRead, { format: 'rtf' });
    expect(result.structuredContent).toMatchObject({
      format: 'rtf',
      content: '',
      totalByteSize: 0,
    });
  });

  it('ranged reads reassemble the exact bytes, and an offset past the end is an empty complete slice (#35)', async () => {
    install(new LinuxWaylandBackend(), waylandScript({ version, types: wlTextOffer('abcdefgh') }));

    const first = await runToolContract(clipboardRead, { format: 'text', offset: 0, limit: 5 });
    expect(first.structuredContent).toMatchObject({
      content: 'abcde',
      totalByteSize: 8,
      complete: false,
      nextOffset: 5,
    });
    const second = await runToolContract(clipboardRead, { format: 'text', offset: 5, limit: 5 });
    expect(second.structuredContent).toMatchObject({
      content: 'fgh',
      totalByteSize: 8,
      complete: true,
    });
    expect(second.structuredContent).not.toHaveProperty('nextOffset');

    const past = await runToolContract(clipboardRead, { format: 'text', offset: 50, limit: 5 });
    expect(past.structuredContent).toMatchObject({
      content: '',
      byteSize: 0,
      totalByteSize: 8,
      complete: true,
    });
  });

  it('previousContent carries the exact prior text, so writing it back is lossless (#35)', async () => {
    install(new LinuxWaylandBackend(), waylandScript({ version, types: wlTextOffer('abc') }));
    const write = await runToolContract(clipboardWrite, { content: 'x' });
    expect(write.structuredContent).toMatchObject({ previousContent: 'abc' });
    expect(textOf(write)).toContain('abc');
  });

  it('no compositor: every tool fails clipboard_unavailable naming WAYLAND_DISPLAY', async () => {
    install(new LinuxWaylandBackend(), waylandScript({ version, noCompositor: true }));
    const calls = [
      () => runToolContract(clipboardInspect, {}),
      () => runToolContract(clipboardRead, { format: 'text' }),
      () => runToolContract(clipboardRead, { format: 'html' }),
      () => runToolContract(clipboardRead, { format: 'auto' }),
      () => runToolContract(clipboardWrite, { content: 'abc' }),
      () => runToolContract(clipboardWrite, { clear: true }),
    ];
    for (const call of calls) {
      const error = wireError(await call());
      expect(error).toMatchObject({
        code: ServiceUnavailable,
        data: { reason: 'clipboard_unavailable' },
      });
      expect(hintOf(error)).toMatch(/WAYLAND_DISPLAY/);
    }
  });

  it.each(['wl-paste', 'wl-copy'])(
    '%s missing: fails clipboard_unavailable with the install command',
    async (helper) => {
      install(
        new LinuxWaylandBackend(),
        waylandScript({ version, missing: [helper], types: wlTextOffer('abc') }),
      );
      const calls =
        helper === 'wl-paste'
          ? [
              () => runToolContract(clipboardInspect, {}),
              () => runToolContract(clipboardRead, { format: 'text' }),
              () => runToolContract(clipboardRead, { format: 'html' }),
              () => runToolContract(clipboardRead, { format: 'auto' }),
            ]
          : [
              () => runToolContract(clipboardWrite, { content: 'abc' }),
              () => runToolContract(clipboardWrite, { clear: true }),
            ];
      for (const call of calls) {
        const error = wireError(await call());
        expect(error).toMatchObject({
          code: ServiceUnavailable,
          data: { reason: 'clipboard_unavailable' },
        });
        expect(hintOf(error)).toMatch(/apt install wl-clipboard/);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// #36 — macOS and Windows raise the typed categories too.
// ---------------------------------------------------------------------------

describe('macOS and Windows typed outcomes', () => {
  it('macOS: an absent HTML representation fails format_unavailable', async () => {
    install(new MacosBackend(), () => ({ stdout: JSON.stringify({ present: false }) }));
    const error = wireError(await runToolContract(clipboardRead, { format: 'html' }));
    expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
  });

  it('macOS: text on an empty pasteboard fails format_unavailable', async () => {
    install(new MacosBackend(), () => ({ stdout: '[]' }));
    const error = wireError(await runToolContract(clipboardRead, { format: 'text' }));
    expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
  });

  it('Windows: an absent RTF representation fails format_unavailable', async () => {
    install(new WindowsBackend(), () => ({ stdout: JSON.stringify({ present: false }) }));
    const error = wireError(await runToolContract(clipboardRead, { format: 'rtf' }));
    expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
  });

  it('Windows: a missing powershell.exe fails clipboard_unavailable on every tool', async () => {
    install(new WindowsBackend(), () => ({ errorCode: 'ENOENT' }));
    const calls = [
      () => runToolContract(clipboardInspect, {}),
      () => runToolContract(clipboardRead, { format: 'text' }),
      () => runToolContract(clipboardWrite, { content: 'abc' }),
    ];
    for (const call of calls) {
      const error = wireError(await call());
      expect(error).toMatchObject({
        code: ServiceUnavailable,
        data: { reason: 'clipboard_unavailable' },
      });
      expect(hintOf(error)).toMatch(/PowerShell/);
    }
  });

  it('Windows: an unreadable PowerShell response is not mistaken for an absent format', async () => {
    install(new WindowsBackend(), () => ({ stdout: JSON.stringify({ unexpected: true }) }));
    const error = wireError(await runToolContract(clipboardRead, { format: 'html' }));
    expect(error.data?.reason).toBeUndefined();
    expect(error.code).not.toBe(NotFound);
  });
});

// ---------------------------------------------------------------------------
// #37 — Windows HTML reads return the CF_HTML fragment; #30/#31 — stdin writers.
// ---------------------------------------------------------------------------

/** Integer literal a PowerShell script assigns to `$name`. */
function psInt(script: string, name: string): number {
  const match = new RegExp(`^\\$${name} = (\\d+)$`, 'm').exec(script);
  if (!match?.[1]) throw new Error(`script assigns no $${name}`);
  return Number(match[1]);
}

/** Windows world whose clipboard holds the raw `HTML Format` bytes `payload`. */
function windowsHtmlScript(payload: Buffer): HelperScript {
  return (_command, args) => {
    const script = args.at(-1) ?? '';
    if (!script.includes("'HTML Format'")) return { stdout: 'null' };
    let dataEnd = payload.byteLength;
    while (dataEnd > 0 && payload[dataEnd - 1] === 0) dataEnd--;
    const from = Math.min(psInt(script, 'windowOffset'), payload.byteLength);
    return {
      stdout: JSON.stringify({
        present: true,
        total: payload.byteLength,
        dataEnd,
        sha256: createHash('sha256').update(payload).digest('base64'),
        prefixBase64: payload.subarray(0, psInt(script, 'prefixLimit')).toString('base64'),
        contentBase64: payload
          .subarray(from, from + psInt(script, 'windowLimit'))
          .toString('base64'),
      }),
    };
  };
}

describe('Windows clipboard_read html over CF_HTML (#37)', () => {
  it('returns the fragment on both surfaces, never the header', async () => {
    install(new WindowsBackend(), windowsHtmlScript(buildCfHtml('<p>café 😀</p>')));
    const result = await runToolContract(clipboardRead, { format: 'html' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      format: 'html',
      content: '<p>café 😀</p>',
      byteSize: Buffer.byteLength('<p>café 😀</p>'),
      totalByteSize: Buffer.byteLength('<p>café 😀</p>'),
      complete: true,
    });
    const text = textOf(result);
    expect(text).toContain('<p>café 😀</p>');
    expect(text).not.toMatch(/Version:|StartFragment/);
  });

  it('pages a large fragment by nextOffset and reassembles it exactly', async () => {
    const fragment = `<div>${'é😀x'.repeat(40_000)}</div>`;
    install(new WindowsBackend(), windowsHtmlScript(buildCfHtml(fragment)));
    const pieces: string[] = [];
    let offset: number | undefined = 0;
    let calls = 0;
    while (offset !== undefined) {
      const result = await runToolContract(clipboardRead, {
        format: 'html',
        offset,
        limit: 100_000,
      });
      const structured = result.structuredContent as {
        complete: boolean;
        content: string;
        nextOffset?: number;
        totalByteSize: number;
      };
      expect(structured.totalByteSize).toBe(Buffer.byteLength(fragment));
      pieces.push(structured.content);
      if (!structured.complete)
        expect(textOf(result)).toContain(`**Next offset:** ${structured.nextOffset}`);
      offset = structured.nextOffset;
      calls++;
    }
    expect(calls).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(fragment);
  });

  it('an offset past the fragment is an empty complete slice', async () => {
    install(new WindowsBackend(), windowsHtmlScript(buildCfHtml('<p>ok</p>')));
    const result = await runToolContract(clipboardRead, { format: 'html', offset: 50, limit: 4 });
    expect(result.structuredContent).toMatchObject({
      content: '',
      byteSize: 0,
      totalByteSize: 9,
      complete: true,
    });
    expect((result.structuredContent as { nextOffset?: number }).nextOffset).toBeUndefined();
  });

  it('a malformed header is a SerializationError naming the field, not format_unavailable', async () => {
    const broken = Buffer.from(
      buildCfHtml('<p>x</p>')
        .toString('latin1')
        .replace(/EndFragment:\d+/, 'EndFragment:9999999999'),
      'latin1',
    );
    install(new WindowsBackend(), windowsHtmlScript(broken));
    const result = await runToolContract(clipboardRead, { format: 'html' });
    const error = wireError(result);
    expect(error.code).toBe(-32070);
    expect(error.data?.reason).toBeUndefined();
    expect(textOf(result)).toContain('EndFragment');
  });
});

describe('clipboard_write through the stdin writers (#30, #31)', () => {
  it.each([
    ['macOS', () => new MacosBackend(), 'osascript'],
    ['Windows', () => new WindowsBackend(), 'powershell.exe'],
  ] as const)('%s: a 1 MiB HTML write succeeds on both surfaces', async (_label, make, helper) => {
    const fake = install(make(), (command) => {
      // Inspection (prior-text capture) reports an empty clipboard.
      return command === helper ? { stdout: '[]' } : { errorCode: 'ENOENT' };
    });
    const html = `<p>${'x'.repeat(1048569)}</p>`;
    const result = await runToolContract(clipboardWrite, { content: html, format: 'html' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ format: 'html', byteSize: 1048576 });
    expect(textOf(result)).toContain('1,048,576 bytes');
    const writer = fake.calls.at(-1);
    expect(writer?.stdin?.byteLength).toBeGreaterThan(2 * 1048576);
    expect(writer?.args.join('').length).toBeLessThan(4096);
  });

  it('macOS: a failed pasteboard set surfaces as an error, not a success', async () => {
    install(new MacosBackend(), (_command, args) =>
      args.at(-1)?.includes('fileHandleWithStandardInput')
        ? { exitCode: 1, stderr: 'execution error: Error: setting public.html failed (-2700)' }
        : { stdout: '[]' },
    );
    const result = await runToolContract(clipboardWrite, { content: '<p>x</p>', format: 'html' });
    const error = wireError(result);
    expect(error.data?.reason).toBeUndefined();
    expect(textOf(result)).toContain('setting public.html failed');
  });

  it('macOS: previousContent is still captured before the text write', async () => {
    const fake = install(new MacosBackend(), (command, args) => {
      if (command === 'pbpaste') return { stdout: 'prior text' };
      if (args.at(-1)?.includes('fileHandleWithStandardInput')) return { stdout: 'ok' };
      return { stdout: JSON.stringify([{ type: 'public.utf8-plain-text', bytes: 10 }]) };
    });
    const result = await runToolContract(clipboardWrite, { content: 'new', format: 'text' });
    expect(result.structuredContent).toMatchObject({
      format: 'text',
      byteSize: 3,
      previousContent: 'prior text',
    });
    expect(textOf(result)).toContain('prior text');
    expect(fake.calls.map((call) => call.command)).toEqual(['osascript', 'pbpaste', 'osascript']);
    expect(fake.calls.some((call) => call.command === 'pbcopy')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unreadable helper output is a SerializationError — never the caller's
// ValidationError, never an absent format, and never echoed onto the wire.
// ---------------------------------------------------------------------------

describe('unreadable helper output on macOS and Windows reads', () => {
  const SerializationError = -32070;
  const UNREADABLE = [
    ['non-JSON output', 'At line:1 char:1 secret-clipboard-bytes'],
    ['an object with no present flag', JSON.stringify({ unexpected: 'secret-clipboard-bytes' })],
    ['an empty JSON array', '[]'],
    [
      'a present envelope missing its total',
      JSON.stringify({
        present: true,
        contentBase64: Buffer.from('secret-clipboard-bytes').toString('base64'),
      }),
    ],
  ] as const;

  const macosFormats = ['html', 'rtf', 'image'] as const;
  const windowsFormats = ['text', 'rtf', 'image'] as const;

  it.each(UNREADABLE)('macOS: %s fails as a SerializationError', async (_label, stdout) => {
    for (const format of macosFormats) {
      install(new MacosBackend(), () => ({ stdout }));
      const result = await runToolContract(clipboardRead, { format });
      const error = wireError(result);
      expect(error.code).toBe(SerializationError);
      expect(error.data?.reason).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('secret-clipboard-bytes');
    }
  });

  it.each(UNREADABLE)('Windows: %s fails as a SerializationError', async (_label, stdout) => {
    for (const format of windowsFormats) {
      install(new WindowsBackend(), () => ({ stdout }));
      const result = await runToolContract(clipboardRead, { format });
      const error = wireError(result);
      expect(error.code).toBe(SerializationError);
      expect(error.data?.reason).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('secret-clipboard-bytes');
    }
  });

  it('a genuinely absent format is still format_unavailable on both platforms', async () => {
    for (const make of [() => new MacosBackend(), () => new WindowsBackend()]) {
      install(make(), () => ({ stdout: JSON.stringify({ present: false }) }));
      const error = wireError(await runToolContract(clipboardRead, { format: 'rtf' }));
      expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
    }
  });
});
