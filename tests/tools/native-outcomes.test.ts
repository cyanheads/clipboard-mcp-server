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
import { readPngDimensions } from '@/services/clipboard/png-dimensions.js';
import type { ClipboardBackend } from '@/services/clipboard/types.js';
import { WindowsBackend } from '@/services/clipboard/windows-backend.js';
import { REAL_PNG_13x7 } from '../services/clipboard/png-fixtures.js';
import {
  type HelperReply,
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
      itemCount: 0,
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
      rawTypes: [{ type: 'TARGETS' }, { type: 'text/html', bytes: 0 }],
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
      itemCount: 0,
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

/** The JXA script of an osascript invocation: the argument after `-e`. */
function jxaScriptOf(args: readonly string[]): string {
  return args[args.indexOf('-e') + 1] ?? '';
}

/** The item a JXA read was passed after `--`; undefined for a read of the whole pasteboard. */
function jxaItemOf(args: readonly string[]): number | undefined {
  const index = args.indexOf('--');
  return index >= 0 ? Number(args[index + 1]) : undefined;
}

/** True for the JXA inspection script, which alone prints the `hasFilePaths` flag. */
function isJxaInspect(script: string): boolean {
  return script.includes('hasFilePaths');
}

/** The `{ itemCount, hasFilePaths, types }` description the JXA inspection script prints. */
function macosInspection(
  types: readonly object[],
  { itemCount = types.length > 0 ? 1 : 0, hasFilePaths = false } = {},
): string {
  return JSON.stringify({ itemCount, hasFilePaths, types });
}

/** An empty macOS pasteboard: no types and no items, and every ranged read is absent. */
const macosEmptyScript: HelperScript = (_command, args) =>
  isJxaInspect(jxaScriptOf(args))
    ? { stdout: macosInspection([]) }
    : { stdout: JSON.stringify({ present: false }) };

describe('macOS and Windows typed outcomes', () => {
  it('macOS: an absent HTML representation fails format_unavailable', async () => {
    install(new MacosBackend(), () => ({ stdout: JSON.stringify({ present: false }) }));
    const error = wireError(await runToolContract(clipboardRead, { format: 'html' }));
    expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
  });

  it('macOS: an empty pasteboard inspects as empty with no items; text and auto fail format_unavailable', async () => {
    install(new MacosBackend(), macosEmptyScript);
    const inspect = await runToolContract(clipboardInspect, {});
    expect(inspect.structuredContent).toEqual({
      primaryFormat: 'empty',
      availableFormats: [],
      itemCount: 0,
      rawTypes: [],
    });
    expect(textOf(inspect)).toContain('**Item count:** 0');
    for (const format of ['text', 'auto'] as const) {
      const result = await runToolContract(clipboardRead, { format });
      expect(wireError(result), format).toMatchObject({
        code: NotFound,
        data: { reason: 'format_unavailable' },
      });
      expect(textOf(result), format).toMatch(/not present on the clipboard|Clipboard is empty/);
    }
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

/**
 * The present envelope a ranged PowerShell read prints: the `$offset`/`$limit`
 * window of `bytes` and their SHA-256, as `psSliceSnippet` emits them.
 */
function psWindow(script: string, bytes: Buffer, extra: Record<string, number> = {}): HelperReply {
  const from = Math.min(psInt(script, 'offset'), bytes.byteLength);
  return {
    stdout: JSON.stringify({
      present: true,
      total: bytes.byteLength,
      contentBase64: bytes.subarray(from, from + psInt(script, 'limit')).toString('base64'),
      revision: createHash('sha256').update(bytes).digest('base64'),
      ...extra,
    }),
  };
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
      // The prior-text read finds no text; the writer's stdout is not read.
      return command === helper
        ? { stdout: JSON.stringify({ present: false }) }
        : { errorCode: 'ENOENT' };
    });
    const html = `<p>${'x'.repeat(1048569)}</p>`;
    const result = await runToolContract(clipboardWrite, { content: html, format: 'html' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ format: 'html', byteSize: 1048576 });
    expect(result.structuredContent).not.toHaveProperty('previousContent');
    expect(textOf(result)).toContain('1,048,576 bytes');
    const writer = fake.calls.at(-1);
    expect(writer?.stdin?.byteLength).toBeGreaterThan(2 * 1048576);
    expect(writer?.args.join('').length).toBeLessThan(4096);
  });

  it('macOS: a failed pasteboard set surfaces as an error, not a success', async () => {
    install(new MacosBackend(), (_command, args) =>
      jxaScriptOf(args).includes('fileHandleWithStandardInput')
        ? { exitCode: 1, stderr: 'execution error: Error: setting public.html failed (-2700)' }
        : { stdout: JSON.stringify({ present: false }) },
    );
    const result = await runToolContract(clipboardWrite, { content: '<p>x</p>', format: 'html' });
    const error = wireError(result);
    expect(error.data?.reason).toBeUndefined();
    expect(textOf(result)).toContain('setting public.html failed');
  });

  it('macOS: previousContent is still captured before the text write, through one JXA read', async () => {
    const prior = Buffer.from('﻿prior text');
    const fake = install(new MacosBackend(), (_command, args) => {
      const script = jxaScriptOf(args);
      if (script.includes('fileHandleWithStandardInput')) return { stdout: 'ok' };
      if (script.includes("dataForType('public.utf8-plain-text')")) {
        return {
          stdout: JSON.stringify({
            present: true,
            total: prior.byteLength,
            contentBase64: prior.toString('base64'),
            revision: '31',
            itemCount: 1,
          }),
        };
      }
      return { exitCode: 1, stderr: 'unexpected helper script' };
    });
    const result = await runToolContract(clipboardWrite, { content: 'new', format: 'text' });
    expect(result.structuredContent).toMatchObject({
      format: 'text',
      byteSize: 3,
      previousContent: '﻿prior text',
    });
    expect(textOf(result)).toContain('prior text');
    expect(fake.calls.map((call) => call.command)).toEqual(['osascript', 'osascript']);
    expect(fake.calls.some((call) => ['pbcopy', 'pbpaste'].includes(call.command))).toBe(false);
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

// ---------------------------------------------------------------------------
// #45 — an unreadable pre-read inspection is a typed inspect_unreadable.
// ---------------------------------------------------------------------------

describe('clipboard_read auto over an unreadable inspection (#45)', () => {
  const SerializationError = -32070;

  it.each([
    ['macOS', () => new MacosBackend()],
    ['Windows', () => new WindowsBackend()],
  ] as const)(
    '%s: auto fails inspect_unreadable with its hint on both surfaces',
    async (platform, make) => {
      install(make(), () => ({ stdout: 'secret-helper-output, not json' }));
      const result = await runToolContract(clipboardRead, { format: 'auto' });
      const error = wireError(result);
      expect(error).toMatchObject({
        code: SerializationError,
        data: { reason: 'inspect_unreadable', platform },
      });
      expect(hintOf(error)).toMatch(/clipboard_read/);
      expect(textOf(result)).toContain(hintOf(error));
      expect(JSON.stringify(error.data)).not.toContain('secret-helper-output');
    },
  );

  it('characterization: a readable inspection still resolves auto to the richest format', async () => {
    install(
      new LinuxWaylandBackend(),
      waylandScript({ version: '2.2', types: wlTextOffer('abc') }),
    );
    const result = await runToolContract(clipboardRead, { format: 'auto' });
    expect(result.structuredContent).toMatchObject({ format: 'text', content: 'abc' });
  });
});

// ---------------------------------------------------------------------------
// #43 — Windows image reads take the PNG format before GetImage().
// ---------------------------------------------------------------------------

interface WindowsImageWorld {
  /** A GDI bitmap GetImage() can return, re-encoded as this PNG at 13x7. */
  bitmap?: Buffer;
  /** Bytes of the registered `PNG` format. */
  png?: Buffer;
  text?: string;
}

/**
 * Windows world answering the inspection, text, and image scripts. The image
 * script's two sources are modeled separately: the `PNG` format answers only a
 * script that reads it, and GetImage() answers only from a bitmap.
 */
function windowsImageScript(world: WindowsImageWorld): HelperScript {
  return (_command, args) => {
    const script = args.at(-1) ?? '';
    if (script.includes('GetFormats')) {
      const listing = [
        ...(world.png ? [{ type: 'PNG', bytes: world.png.byteLength }] : []),
        ...(world.bitmap ? [{ type: 'Bitmap' }] : []),
        ...(world.text !== undefined
          ? [{ type: 'UnicodeText', bytes: Buffer.byteLength(world.text) }]
          : []),
      ];
      return { stdout: JSON.stringify(listing) };
    }
    if (script.includes('nativeTextFormats')) {
      return world.text === undefined
        ? { stdout: JSON.stringify({ present: false }) }
        : psWindow(script, Buffer.from(world.text));
    }
    const png = script.includes("GetData('PNG', $false)") ? world.png : undefined;
    // A script that decodes the PNG first (System.Drawing, modeled by the header
    // check) takes it only when it decodes; one that does not takes any bytes.
    const decoded =
      png && png.byteLength > 0
        ? script.includes('[System.Drawing.Image]::FromStream(')
          ? readPngDimensions(png)
          : {}
        : undefined;
    if (png && decoded) return psWindow(script, png, { ...decoded });
    if (world.bitmap) return psWindow(script, world.bitmap, { width: 13, height: 7 });
    if (png?.byteLength === 0) return psWindow(script, png);
    return { stdout: JSON.stringify({ present: false }) };
  };
}

describe('Windows clipboard_read image (#43)', () => {
  it('a zero-length PNG beside text: image and auto return the empty image, with no image block', async () => {
    install(new WindowsBackend(), windowsImageScript({ png: Buffer.alloc(0), text: 'abc' }));

    const inspect = await runToolContract(clipboardInspect, {});
    expect(inspect.structuredContent).toMatchObject({
      primaryFormat: 'image',
      availableFormats: ['text', 'image'],
    });

    for (const format of ['image', 'auto'] as const) {
      const result = await runToolContract(clipboardRead, { format });
      expect(result.isError, format).toBeFalsy();
      expect(result.structuredContent).toEqual({
        format: 'image',
        content: '',
        byteSize: 0,
        totalByteSize: 0,
        complete: true,
        representationId: `image:${createHash('sha256').update(Buffer.alloc(0)).digest('base64')}`,
        itemCount: 1,
      });
      expect(result.content.some((b) => b.type === 'image')).toBe(false);
    }
  });

  it('a decodable PNG with no bitmap returns that PNG with its decoded dimensions', async () => {
    install(new WindowsBackend(), windowsImageScript({ png: REAL_PNG_13x7 }));
    const result = await runToolContract(clipboardRead, { format: 'image' });
    expect(result.structuredContent).toMatchObject({
      format: 'image',
      content: REAL_PNG_13x7.toString('base64'),
      width: 13,
      height: 7,
      totalByteSize: REAL_PNG_13x7.byteLength,
    });
    expect(result.content.some((b) => b.type === 'image')).toBe(true);
  });

  it('an undecodable PNG beside a bitmap reads the bitmap; alone, image and auto fail format_unavailable', async () => {
    const notPng = Buffer.from('not a png');
    install(new WindowsBackend(), windowsImageScript({ png: notPng, bitmap: REAL_PNG_13x7 }));
    const withBitmap = await runToolContract(clipboardRead, { format: 'image' });
    expect(withBitmap.structuredContent).toMatchObject({
      content: REAL_PNG_13x7.toString('base64'),
      width: 13,
      height: 7,
    });

    install(new WindowsBackend(), windowsImageScript({ png: notPng }));
    for (const format of ['image', 'auto'] as const) {
      const result = await runToolContract(clipboardRead, { format });
      expect(wireError(result), format).toMatchObject({
        code: NotFound,
        data: { reason: 'format_unavailable' },
      });
      expect(result.content.some((b) => b.type === 'image')).toBe(false);
    }
  });

  it('auto over an undecodable PNG beside text returns the text (#46)', async () => {
    install(
      new WindowsBackend(),
      windowsImageScript({ png: Buffer.from('not a png'), text: 'abc' }),
    );
    const result = await runToolContract(clipboardRead, { format: 'auto' });
    expect(result.structuredContent).toMatchObject({ format: 'text', content: 'abc' });
    expect(result.content.some((b) => b.type === 'image')).toBe(false);
  });

  it('a PNG slice past its header still carries the decoded dimensions', async () => {
    install(new WindowsBackend(), windowsImageScript({ png: REAL_PNG_13x7 }));
    const result = await runToolContract(clipboardRead, { format: 'image', offset: 40, limit: 10 });
    expect(result.structuredContent).toMatchObject({ width: 13, height: 7, byteSize: 10 });
  });

  it('characterization: a Bitmap-only clipboard still reads through GetImage()', async () => {
    install(new WindowsBackend(), windowsImageScript({ bitmap: REAL_PNG_13x7 }));
    const result = await runToolContract(clipboardRead, { format: 'image' });
    expect(result.structuredContent).toMatchObject({ format: 'image', width: 13, height: 7 });
  });

  it('a Bitmap-only clipboard lists image with no size, and auto reads it (#41)', async () => {
    install(new WindowsBackend(), windowsImageScript({ bitmap: REAL_PNG_13x7 }));
    const inspect = await runToolContract(clipboardInspect, {});
    expect(inspect.structuredContent).toEqual({
      primaryFormat: 'image',
      availableFormats: ['image'],
      itemCount: 1,
      rawTypes: [{ type: 'Bitmap' }],
    });
    expect(textOf(inspect)).toContain('| `Bitmap` | unknown |');
    const result = await runToolContract(clipboardRead, { format: 'auto' });
    expect(result.structuredContent).toMatchObject({ format: 'image', width: 13, height: 7 });
  });
});

// ---------------------------------------------------------------------------
// #38 — representationId ties the slices of a chunked read to one value.
// ---------------------------------------------------------------------------

const Conflict = -32002;

/** One successful clipboard_read's structuredContent, asserting it did not fail. */
async function readOk(input: Record<string, unknown>) {
  const result = await runToolContract(clipboardRead, input);
  expect(result.isError, JSON.stringify(input)).toBeFalsy();
  return {
    result,
    structured: result.structuredContent as {
      content: string;
      format: string;
      nextOffset?: number;
      representationId: string;
      totalByteSize: number;
    },
  };
}

/** Assert a call failed representation_changed with the declared hint on both surfaces. */
function expectRepresentationChanged(result: Awaited<ReturnType<typeof runToolContract>>) {
  const error = wireError(result);
  expect(error).toMatchObject({ code: Conflict, data: { reason: 'representation_changed' } });
  expect(hintOf(error)).toBe(
    'The value being read is not the one the earlier slices came from: another application copied after an earlier slice or during this call, or this continuation named a different format or item. Discard the bytes read so far and restart at offset 0 without representationId, passing the same item on every slice.',
  );
  expect(textOf(result)).toContain(hintOf(error));
  expect(result.structuredContent).not.toHaveProperty('content');
  expect(result.content.some((b) => b.type === 'image')).toBe(false);
}

interface TextWorld {
  /** Empty the clipboard. */
  clear(): void;
  /** Replace the clipboard with `value` under the text types only. */
  setText(value: string): void;
  /** Offer `value` as both text and HTML. */
  setTextAndHtml(value: string): void;
}

/** Linux worlds whose contents the test replaces between calls. */
const linuxWorlds = [
  [
    'Wayland',
    (): TextWorld => {
      const world: WaylandWorld = { version: '2.2' };
      install(new LinuxWaylandBackend(), waylandScript(world));
      return {
        setText: (value) => {
          world.types = wlTextOffer(value);
        },
        setTextAndHtml: (value) => {
          world.types = { ...wlTextOffer(value), 'text/html': value };
        },
        clear: () => {
          world.types = undefined;
        },
      };
    },
  ],
  [
    'X11',
    (): TextWorld => {
      const world: X11World = { version: '0.13' };
      install(new LinuxX11Backend(), x11Script(world));
      return {
        setText: (value) => {
          world.owner = { kind: 'xsel', types: { UTF8_STRING: value } };
        },
        setTextAndHtml: (value) => {
          world.owner = { kind: 'xsel', types: { UTF8_STRING: value, 'text/html': value } };
        },
        clear: () => {
          world.owner = undefined;
        },
      };
    },
  ],
] as const;

describe.each(linuxWorlds)('%s: representationId across slices (#38)', (_platform, makeWorld) => {
  it('full and sliced reads of an unchanged value share one token on both surfaces', async () => {
    makeWorld().setText('AAAA1111');
    const first = await readOk({ format: 'text', offset: 0, limit: 4 });
    expect(first.structured).toMatchObject({ content: 'AAAA', totalByteSize: 8, nextOffset: 4 });
    expect(first.structured.representationId).toMatch(/\S/);
    expect(textOf(first.result)).toContain(
      `**Representation ID:** ${first.structured.representationId}`,
    );

    const whole = await readOk({ format: 'text' });
    expect(whole.structured.representationId).toBe(first.structured.representationId);

    const next = await readOk({
      format: 'text',
      offset: 4,
      limit: 4,
      representationId: first.structured.representationId,
    });
    expect(next.structured).toMatchObject({ content: '1111', complete: true });
    expect(next.structured.representationId).toBe(first.structured.representationId);
  });

  it('a same-size replacement between slices fails the continuation with representation_changed', async () => {
    const world = makeWorld();
    world.setText('AAAA1111');
    const first = await readOk({ format: 'text', offset: 0, limit: 4 });
    world.setText('BBBB2222');
    expectRepresentationChanged(
      await runToolContract(clipboardRead, {
        format: 'text',
        offset: first.structured.nextOffset,
        limit: 4,
        representationId: first.structured.representationId,
      }),
    );
  });

  it('a call without representationId still reads the replaced value as before', async () => {
    const world = makeWorld();
    world.setText('AAAA1111');
    const first = await readOk({ format: 'text', offset: 0, limit: 4 });
    world.setText('BBBB2222');
    const next = await readOk({ format: 'text', offset: 4, limit: 4 });
    expect(next.structured).toMatchObject({ content: '2222', totalByteSize: 8 });
    expect(next.structured.representationId).not.toBe(first.structured.representationId);
  });

  it('an auto continuation that resolves to another format conflicts, even over identical bytes', async () => {
    const world = makeWorld();
    world.setText('same');
    const first = await readOk({ format: 'auto', offset: 0, limit: 4 });
    expect(first.structured.format).toBe('text');
    world.setTextAndHtml('same');
    expectRepresentationChanged(
      await runToolContract(clipboardRead, {
        format: 'auto',
        offset: 0,
        limit: 4,
        representationId: first.structured.representationId,
      }),
    );
  });

  it('a clipboard emptied between slices still fails format_unavailable', async () => {
    const world = makeWorld();
    world.setText('AAAA1111');
    const first = await readOk({ format: 'text', offset: 0, limit: 4 });
    world.clear();
    for (const format of ['text', 'auto'] as const) {
      const error = wireError(
        await runToolContract(clipboardRead, {
          format,
          offset: 4,
          limit: 4,
          representationId: first.structured.representationId,
        }),
      );
      expect(error, format).toMatchObject({
        code: NotFound,
        data: { reason: 'format_unavailable' },
      });
    }
  });

  it('a clipboard that no longer holds the format between slices still fails format_unavailable', async () => {
    const world = makeWorld();
    world.setTextAndHtml('<b>x</b>');
    const first = await readOk({ format: 'html', offset: 0, limit: 4 });
    world.setText('<b>x</b>');
    const error = wireError(
      await runToolContract(clipboardRead, {
        format: 'html',
        offset: 4,
        limit: 4,
        representationId: first.structured.representationId,
      }),
    );
    expect(error).toMatchObject({ code: NotFound, data: { reason: 'format_unavailable' } });
  });
});

/** Integer the macOS slice snippet interpolates into `pattern`. */
function jxaInt(script: string, pattern: RegExp): number {
  const match = pattern.exec(script);
  if (!match?.[1]) throw new Error(`script has no ${pattern}`);
  return Number(match[1]);
}

interface MacosTextWorld {
  changeCount: number;
  /** The script sees changeCount move between its two samples. */
  changesMidRead?: boolean;
  text?: Buffer;
}

/**
 * macOS world holding plain text. A read script answers the window its slice
 * snippet asks for with `revision: String(changeCount)`, or `{ changed: true }`
 * when the pasteboard is written between its two changeCount samples.
 */
function macosTextScript(world: MacosTextWorld): HelperScript {
  return (_command, args) => {
    const script = jxaScriptOf(args);
    if (isJxaInspect(script)) {
      return {
        stdout: macosInspection(
          world.text ? [{ type: 'public.utf8-plain-text', bytes: world.text.byteLength }] : [],
        ),
      };
    }
    if (world.changesMidRead) return { stdout: JSON.stringify({ changed: true }) };
    const text = world.text;
    if (!text || !script.includes("dataForType('public.utf8-plain-text')")) {
      return { stdout: JSON.stringify({ present: false }) };
    }
    return { stdout: jxaWindow(script, text, String(world.changeCount), 1) };
  };
}

/**
 * The present envelope a JXA read script prints: the `[offset, offset + limit)`
 * window its slice snippet asks for, as `jxaSliceSnippet` cuts it.
 */
function jxaWindow(
  script: string,
  bytes: Buffer,
  revision: string,
  itemCount: number,
  extra: Record<string, number> = {},
): string {
  const from = Math.min(jxaInt(script, /Math\.min\((\d+), total\)/), bytes.byteLength);
  const limit = jxaInt(script, /Math\.min\((\d+), total - location\)/);
  return JSON.stringify({
    present: true,
    total: bytes.byteLength,
    contentBase64: bytes.subarray(from, from + limit).toString('base64'),
    revision,
    itemCount,
    ...extra,
  });
}

/** Windows world holding plain text, answered as `psSliceSnippet` would. */
function windowsTextScript(world: { text: Buffer }): HelperScript {
  return (_command, args) => psWindow(args.at(-1) ?? '', world.text);
}

describe('macOS and Windows: representationId across slices (#38)', () => {
  it('macOS: the token follows changeCount — stable while unchanged, a same-size replacement conflicts', async () => {
    const world: MacosTextWorld = { changeCount: 90, text: Buffer.from('AAAA1111') };
    install(new MacosBackend(), macosTextScript(world));

    const first = await readOk({ format: 'text', offset: 0, limit: 4 });
    expect(first.structured).toMatchObject({ content: 'AAAA', representationId: 'text:90' });
    expect((await readOk({ format: 'text' })).structured.representationId).toBe('text:90');
    const next = await readOk({
      format: 'text',
      offset: 4,
      limit: 4,
      representationId: 'text:90',
    });
    expect(next.structured.content).toBe('1111');

    world.text = Buffer.from('BBBB2222');
    world.changeCount = 91;
    expectRepresentationChanged(
      await runToolContract(clipboardRead, {
        format: 'text',
        offset: 4,
        limit: 4,
        representationId: 'text:90',
      }),
    );
  });

  it('macOS: a change caught between the two changeCount samples fails representation_changed with no token passed', async () => {
    install(
      new MacosBackend(),
      macosTextScript({ changeCount: 5, changesMidRead: true, text: Buffer.from('x') }),
    );
    for (const input of [{ format: 'text' }, { format: 'auto' }, { format: 'text', offset: 0 }]) {
      const result = await runToolContract(clipboardRead, input);
      expectRepresentationChanged(result);
      expect(wireError(result).data?.platform).toBe('macOS');
    }
  });

  it('Windows: a same-size replacement between slices conflicts; an unchanged value continues', async () => {
    const world = { text: Buffer.from('AAAA1111') };
    install(new WindowsBackend(), windowsTextScript(world));

    const first = await readOk({ format: 'text', offset: 0, limit: 4 });
    const token = first.structured.representationId;
    expect(token).toBe(`text:${createHash('sha256').update(world.text).digest('base64')}`);
    expect(
      (await readOk({ format: 'text', offset: 4, limit: 4, representationId: token })).structured
        .content,
    ).toBe('1111');

    world.text = Buffer.from('BBBB2222');
    expectRepresentationChanged(
      await runToolContract(clipboardRead, {
        format: 'text',
        offset: 4,
        limit: 4,
        representationId: token,
      }),
    );
  });

  it('Windows: the two HTML Format calls hashing differently fail representation_changed on the wire', async () => {
    const before = buildCfHtml(`<p>${'a'.repeat(300_000)}</p>`);
    const after = buildCfHtml(`<p>${'b'.repeat(300_000)}</p>`);
    let call = 0;
    install(new WindowsBackend(), (command, args) =>
      windowsHtmlScript(call++ === 0 ? before : after)(command, args),
    );
    const result = await runToolContract(clipboardRead, {
      format: 'html',
      offset: 200_000,
      limit: 10,
    });
    expectRepresentationChanged(result);
    expect(wireError(result).data?.platform).toBe('Windows');
  });

  it('Windows: an HTML continuation across the one- and two-call paths keeps one token', async () => {
    const fragment = `<p>${'a'.repeat(300_000)}Z</p>`;
    install(new WindowsBackend(), windowsHtmlScript(buildCfHtml(fragment)));
    const head = await readOk({ format: 'html', offset: 0, limit: 8 });
    const tail = await readOk({
      format: 'html',
      offset: 300_003,
      limit: 5,
      representationId: head.structured.representationId,
    });
    expect(tail.structured.content).toBe('Z</p>');
    expect(tail.structured.representationId).toBe(head.structured.representationId);
  });
});

// ---------------------------------------------------------------------------
// #57 — clipboard items; #59 — copied files, through each platform's helper.
// ---------------------------------------------------------------------------

/** A path a `files` read can list: one path per line holds no CR or LF. */
const listablePath = (path: string) => !/[\r\n]/.test(path);

/** The notice a 3-item read with no item carries for `format` and its item scope. */
function threeItemNotice(format: string, scope: 'first' | 'joined' | 'all'): string {
  const source = {
    first:
      format === 'image'
        ? 'this "image" read comes from one item: the first holding a PNG, else the first holding another image type'
        : `this "${format}" read comes from the first item that has the format`,
    joined:
      format === 'rtf'
        ? 'this "rtf" read is one RTF document built from every item that holds text, HTML, or RTF'
        : `this "${format}" read joins the ${format} of every item that has it into one value`,
    all: `this "${format}" read lists every item's paths, in item order`,
  }[scope];
  return `The clipboard holds 3 items; ${source}. Pass item (0 to 2) to read one item alone.`;
}

const ONE_OMITTED_NOTICE =
  '1 copied path contains a line break or bytes that are not UTF-8, which one-path-per-line UTF-8 content cannot hold, so it is left out.';

/** One modeled macOS pasteboard item. */
interface MacosItem {
  html?: string;
  /** The local path the item's `public.file-url` resolves to. */
  path?: string;
  text?: string;
}

/**
 * macOS world holding several pasteboard items. A read of the whole pasteboard
 * answers as AppKit does — text joined across items with "\n", HTML from the
 * first item carrying it, every item's listable path — and a read passed
 * `-- <item>` answers from that item alone; an item past the last is absent.
 */
function macosItemsScript(world: {
  changeCount: number;
  items: readonly MacosItem[];
}): HelperScript {
  return (_command, args) => {
    const script = jxaScriptOf(args);
    const { items } = world;
    if (isJxaInspect(script)) {
      const texts = items.flatMap((entry) => (entry.text === undefined ? [] : [entry.text]));
      const html = items.find((entry) => entry.html !== undefined)?.html;
      const paths = items.flatMap((entry) => (entry.path === undefined ? [] : [entry.path]));
      const types = [
        ...(texts.length > 0
          ? [{ type: 'public.utf8-plain-text', bytes: Buffer.byteLength(texts.join('\n')) }]
          : []),
        ...(html !== undefined ? [{ type: 'public.html', bytes: Buffer.byteLength(html) }] : []),
        ...(paths.length > 0
          ? [{ type: 'public.file-url', bytes: Buffer.byteLength(`file://${paths[0]}`) }]
          : []),
      ];
      return {
        stdout: macosInspection(types, {
          itemCount: items.length,
          hasFilePaths: paths.some(listablePath),
        }),
      };
    }
    const item = jxaItemOf(args);
    const selected = item === undefined ? items : items.slice(item, item + 1);
    let bytes: Buffer | undefined;
    let extra: Record<string, number> = {};
    if (script.includes('const paths = item === null')) {
      const paths = selected.flatMap((entry) => (entry.path === undefined ? [] : [entry.path]));
      const listed = paths.filter(listablePath);
      if (listed.length > 0) {
        bytes = Buffer.from(listed.join('\n'));
        extra = { omittedPaths: paths.length - listed.length };
      }
    } else if (script.includes("dataForType('public.utf8-plain-text')")) {
      const texts = selected.flatMap((entry) => (entry.text === undefined ? [] : [entry.text]));
      if (texts.length > 0) bytes = Buffer.from(texts.join('\n'));
    } else if (script.includes("dataForType('public.html')")) {
      const html = selected.find((entry) => entry.html !== undefined)?.html;
      if (html !== undefined) bytes = Buffer.from(html);
    }
    return {
      stdout:
        bytes === undefined
          ? JSON.stringify({ present: false })
          : jxaWindow(script, bytes, String(world.changeCount), items.length, extra),
    };
  };
}

describe('macOS: a multi-item pasteboard through the JXA helper (#57, #59)', () => {
  const ITEMS: MacosItem[] = [0, 1, 2].map((n) => ({
    text: `item ${n}`,
    html: `<p>${n}</p>`,
    path: `/p/${n}`,
  }));

  it('inspect counts the items and ranks files first on both surfaces', async () => {
    install(new MacosBackend(), macosItemsScript({ changeCount: 90, items: ITEMS }));
    const inspect = await runToolContract(clipboardInspect, {});
    expect(inspect.structuredContent).toMatchObject({
      primaryFormat: 'files',
      availableFormats: ['text', 'html', 'files'],
      itemCount: 3,
    });
    expect(textOf(inspect)).toContain('**Item count:** 3');
  });

  it.each([
    ['text', 'item 0\nitem 1\nitem 2', 'joined'],
    ['html', '<p>0</p>', 'first'],
    ['files', '/p/0\n/p/1\n/p/2', 'all'],
  ] as const)(
    'a %s read with no item draws on the items as AppKit does and says how on both surfaces',
    async (format, content, scope) => {
      const fake = install(new MacosBackend(), macosItemsScript({ changeCount: 90, items: ITEMS }));
      const { result, structured } = await readOk({ format });
      const notice = threeItemNotice(format, scope);
      expect(structured).toMatchObject({
        format,
        content,
        itemCount: 3,
        notice,
        representationId: `${format}:90`,
      });
      expect(textOf(result)).toContain(notice);
      expect(textOf(result)).toContain('**Item count:** 3');
      expect(fake.calls.at(-1)?.args).not.toContain('--');
    },
  );

  it('item reads that item alone — passed after --, under its own token, with no notice; auto too', async () => {
    const fake = install(new MacosBackend(), macosItemsScript({ changeCount: 90, items: ITEMS }));
    const { result, structured } = await readOk({ format: 'text', item: 1 });
    expect(structured).toMatchObject({
      content: 'item 1',
      itemCount: 3,
      representationId: 'text#1:90',
    });
    expect(structured).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('The clipboard holds');
    expect(fake.calls.at(-1)?.args.slice(-2)).toEqual(['--', '1']);

    const auto = await readOk({ format: 'auto', item: 2 });
    expect(auto.structured).toMatchObject({
      format: 'files',
      content: '/p/2',
      representationId: 'files#2:90',
    });
  });

  it('an item past the last: an explicit read finds it absent; auto stops at the item count before reading', async () => {
    const fake = install(new MacosBackend(), macosItemsScript({ changeCount: 90, items: ITEMS }));
    const explicit = await runToolContract(clipboardRead, { format: 'html', item: 3 });
    expect(wireError(explicit)).toMatchObject({
      code: NotFound,
      data: { reason: 'format_unavailable', item: 3 },
    });
    expect(textOf(explicit)).toContain(
      'Format "html" is not present on clipboard item 3, or the clipboard has no item 3.',
    );

    const before = fake.calls.length;
    const auto = await runToolContract(clipboardRead, { format: 'auto', item: 3 });
    expect(wireError(auto)).toMatchObject({
      code: NotFound,
      data: { reason: 'format_unavailable', item: 3, itemCount: 3 },
    });
    expect(textOf(auto)).toContain('The clipboard holds 3 items; item 3 is past the last (2).');
    // Only the inspection ran: no read script was spawned for an item that is not there.
    expect(fake.calls.slice(before).map((call) => isJxaInspect(jxaScriptOf(call.args)))).toEqual([
      true,
    ]);
  });

  it('a files read that left a line-break path out says so beside the item notice', async () => {
    install(
      new MacosBackend(),
      macosItemsScript({
        changeCount: 7,
        items: [{ path: '/a' }, { path: '/line\nbreak' }, { path: '/c' }],
      }),
    );
    expect((await runToolContract(clipboardInspect, {})).structuredContent).toMatchObject({
      availableFormats: ['files'],
    });
    const { result, structured } = await readOk({ format: 'files' });
    const notice = `${threeItemNotice('files', 'all')} ${ONE_OMITTED_NOTICE}`;
    expect(structured).toMatchObject({ content: '/a\n/c', totalByteSize: 5, notice });
    expect(textOf(result)).toContain(notice);
  });

  it('a continuation that drops or changes item fails representation_changed; the same item continues', async () => {
    install(new MacosBackend(), macosItemsScript({ changeCount: 90, items: ITEMS }));
    const first = await readOk({ format: 'text', item: 1, offset: 0, limit: 4 });
    expect(first.structured).toMatchObject({
      content: 'item',
      nextOffset: 4,
      representationId: 'text#1:90',
    });
    const { representationId } = first.structured;
    for (const scope of [{ item: 2 }, {}]) {
      expectRepresentationChanged(
        await runToolContract(clipboardRead, {
          format: 'text',
          offset: 4,
          limit: 4,
          representationId,
          ...scope,
        }),
      );
    }
    const next = await readOk({ format: 'text', item: 1, offset: 4, limit: 4, representationId });
    expect(next.structured).toMatchObject({ content: ' 1', complete: true, representationId });
  });
});

/** Install a Linux backend whose clipboard offers exactly `types`. */
type LinuxOffer = (types: Record<string, string>) => void;

const linuxOffers: readonly (readonly [string, string, LinuxOffer])[] = [
  [
    'X11',
    'UTF8_STRING',
    (types) => {
      install(
        new LinuxX11Backend(),
        x11Script({ version: '0.13', owner: { kind: 'xsel', types } }),
      );
    },
  ],
  [
    'Wayland',
    'text/plain',
    (types) => {
      install(new LinuxWaylandBackend(), waylandScript({ version: '2.2', types }));
    },
  ],
];

/** Base64url SHA-256 of `value`: the revision a Linux read reports. */
const linuxRevision = (value: string) => createHash('sha256').update(value).digest('base64url');

describe.each(linuxOffers)(
  '%s: one clipboard item, and files from text/uri-list (#57, #59)',
  (_platform, textType, offer) => {
    it('inspect and read report one item; item 0 reads the same bytes under its own token', async () => {
      offer({ [textType]: 'abc' });
      const inspect = await runToolContract(clipboardInspect, {});
      expect(inspect.structuredContent).toMatchObject({ itemCount: 1, availableFormats: ['text'] });
      expect(textOf(inspect)).toContain('**Item count:** 1');

      const whole = await readOk({ format: 'text' });
      expect(whole.structured).toMatchObject({
        content: 'abc',
        itemCount: 1,
        representationId: `text:${linuxRevision('abc')}`,
      });
      expect(whole.structured).not.toHaveProperty('notice');
      expect(textOf(whole.result)).toContain('**Item count:** 1');

      const scoped = await readOk({ format: 'text', item: 0 });
      expect(scoped.structured).toMatchObject({
        content: 'abc',
        itemCount: 1,
        representationId: `text#0:${linuxRevision('abc')}`,
      });
      expect(scoped.structured).not.toHaveProperty('notice');
    });

    it('item 1 is format_unavailable: an explicit read after listing the types, auto at the item count', async () => {
      offer({ [textType]: 'abc' });
      const explicit = await runToolContract(clipboardRead, { format: 'text', item: 1 });
      expect(wireError(explicit)).toMatchObject({
        code: NotFound,
        data: { reason: 'format_unavailable', item: 1 },
      });
      expect(textOf(explicit)).toContain(
        'Format "text" is not present on clipboard item 1, or the clipboard has no item 1.',
      );

      const auto = await runToolContract(clipboardRead, { format: 'auto', item: 1 });
      expect(wireError(auto)).toMatchObject({
        code: NotFound,
        data: { reason: 'format_unavailable', item: 1, itemCount: 1 },
      });
      expect(textOf(auto)).toContain('The clipboard holds 1 item; item 1 is past the last (0).');
    });

    it('a text/uri-list reads as its local file paths, skipping other URIs; auto ranks it first', async () => {
      const uriList = 'file:///a%20b\r\nhttps://x.test\r\n';
      offer({ 'text/uri-list': uriList, [textType]: 'caption' });
      const inspect = await runToolContract(clipboardInspect, {});
      expect(inspect.structuredContent).toMatchObject({
        primaryFormat: 'files',
        availableFormats: ['text', 'files'],
      });
      expect((inspect.structuredContent as { rawTypes: unknown[] }).rawTypes).toContainEqual({
        type: 'text/uri-list',
        bytes: Buffer.byteLength(uriList),
      });

      for (const format of ['files', 'auto'] as const) {
        const { result, structured } = await readOk({ format });
        expect(structured, format).toMatchObject({
          format: 'files',
          content: '/a b',
          totalByteSize: 4,
          itemCount: 1,
          representationId: `files:${linuxRevision('/a b')}`,
        });
        expect(structured, format).not.toHaveProperty('notice');
        expect(textOf(result)).toContain('/a b');
      }
    });

    it.each([
      ['names no local file', 'https://x.test/a\r\n'],
      ['holds only a line-break path', 'file:///a%0Ab\r\n'],
    ])(
      'a uri-list that %s lists no files: the files read fails, auto reads the text',
      async (_label, uriList) => {
        offer({ 'text/uri-list': uriList, [textType]: 'caption' });
        const inspect = await runToolContract(clipboardInspect, {});
        expect(inspect.structuredContent).toMatchObject({
          primaryFormat: 'text',
          availableFormats: ['text'],
        });
        expect((inspect.structuredContent as { rawTypes: unknown[] }).rawTypes).toContainEqual({
          type: 'text/uri-list',
          bytes: Buffer.byteLength(uriList),
        });

        expect(wireError(await runToolContract(clipboardRead, { format: 'files' }))).toMatchObject({
          code: NotFound,
          data: { reason: 'format_unavailable' },
        });
        const auto = await readOk({ format: 'auto' });
        expect(auto.structured).toMatchObject({ format: 'text', content: 'caption' });
      },
    );

    it('a line-break path beside a listable one is left out and counted in the notice', async () => {
      offer({ 'text/uri-list': 'file:///a%0Ab\r\nfile:///c\r\n' });
      const { result, structured } = await readOk({ format: 'files' });
      expect(structured).toMatchObject({ content: '/c', notice: ONE_OMITTED_NOTICE });
      expect(textOf(result)).toContain(ONE_OMITTED_NOTICE);
    });
  },
);

/**
 * Windows world holding a file drop list, answered as `PS_INSPECT` and
 * `buildPsReadFiles` print it: paths holding a CR or LF are left out and
 * counted, and a list with no path left is a failed measurement and an absent
 * read.
 */
function windowsFilesScript(world: { paths: readonly string[]; text?: string }): HelperScript {
  return (_command, args) => {
    const script = args.at(-1) ?? '';
    const kept = world.paths.filter(listablePath);
    const joined = Buffer.from(kept.join('\n'));
    if (script.includes('GetFormats')) {
      return {
        stdout: JSON.stringify([
          kept.length > 0
            ? { type: 'FileDrop', bytes: joined.byteLength }
            : { type: 'FileDrop', measurementFailed: true },
          ...(world.text !== undefined
            ? [{ type: 'UnicodeText', bytes: Buffer.byteLength(world.text) }]
            : []),
        ]),
      };
    }
    if (script.includes('GetFileDropList()') && kept.length > 0) {
      return psWindow(script, joined, { omittedPaths: world.paths.length - kept.length });
    }
    if (script.includes('nativeTextFormats') && world.text !== undefined) {
      return psWindow(script, Buffer.from(world.text));
    }
    return { stdout: JSON.stringify({ present: false }) };
  };
}

describe('Windows: the file drop list (#59) and the one-item clipboard (#57)', () => {
  const PATHS = ['C:\\Users\\me\\b.txt', 'C:\\Users\\me\\a dir\\a.txt'];
  const sha = (value: string) => createHash('sha256').update(value).digest('base64');

  it('FileDrop reads as its paths in list order, one per line; inspect and auto rank files first', async () => {
    install(new WindowsBackend(), windowsFilesScript({ paths: PATHS, text: 'caption' }));
    const joined = PATHS.join('\n');
    const inspect = await runToolContract(clipboardInspect, {});
    expect(inspect.structuredContent).toEqual({
      primaryFormat: 'files',
      availableFormats: ['text', 'files'],
      itemCount: 1,
      rawTypes: [
        { type: 'FileDrop', bytes: Buffer.byteLength(joined) },
        { type: 'UnicodeText', bytes: 7 },
      ],
    });
    for (const format of ['files', 'auto'] as const) {
      const { result, structured } = await readOk({ format });
      expect(structured, format).toMatchObject({
        format: 'files',
        content: joined,
        itemCount: 1,
        representationId: `files:${sha(joined)}`,
      });
      expect(structured, format).not.toHaveProperty('notice');
      expect(textOf(result)).toContain(joined);
    }
  });

  it('a line-break path is left out and counted; a list of only such paths lists no files and auto reads the text', async () => {
    install(
      new WindowsBackend(),
      windowsFilesScript({ paths: ['C:\\a.txt', 'C:\\line\nbreak.txt'] }),
    );
    const counted = await readOk({ format: 'files' });
    expect(counted.structured).toMatchObject({ content: 'C:\\a.txt', notice: ONE_OMITTED_NOTICE });
    expect(textOf(counted.result)).toContain(ONE_OMITTED_NOTICE);

    install(
      new WindowsBackend(),
      windowsFilesScript({ paths: ['C:\\line\nbreak.txt'], text: 'caption' }),
    );
    expect((await runToolContract(clipboardInspect, {})).structuredContent).toMatchObject({
      primaryFormat: 'text',
      availableFormats: ['text'],
      rawTypes: [
        { type: 'FileDrop', measurementFailed: true },
        { type: 'UnicodeText', bytes: 7 },
      ],
    });
    expect(wireError(await runToolContract(clipboardRead, { format: 'files' }))).toMatchObject({
      code: NotFound,
      data: { reason: 'format_unavailable' },
    });
    expect((await readOk({ format: 'auto' })).structured).toMatchObject({
      format: 'text',
      content: 'caption',
    });
  });

  it('item 1 fails format_unavailable without spawning a helper; auto checks it after inspecting; item 0 reads', async () => {
    const fake = install(new WindowsBackend(), windowsFilesScript({ paths: PATHS }));
    for (const format of ['files', 'text', 'html', 'rtf', 'image'] as const) {
      const result = await runToolContract(clipboardRead, { format, item: 1 });
      expect(wireError(result), format).toMatchObject({
        code: NotFound,
        data: { reason: 'format_unavailable', item: 1 },
      });
    }
    expect(fake.calls).toHaveLength(0);

    const auto = await runToolContract(clipboardRead, { format: 'auto', item: 1 });
    expect(wireError(auto)).toMatchObject({
      data: { reason: 'format_unavailable', item: 1, itemCount: 1 },
    });
    expect(fake.calls.map((call) => call.args.at(-1)?.includes('GetFormats'))).toEqual([true]);

    const scoped = await readOk({ format: 'files', item: 0 });
    expect(scoped.structured).toMatchObject({
      content: PATHS.join('\n'),
      representationId: `files#0:${sha(PATHS.join('\n'))}`,
    });
  });
});
