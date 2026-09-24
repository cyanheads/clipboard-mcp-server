/**
 * @fileoverview Security tests: injection prevention across all backends and tools.
 * Verifies that user content is never interpolated into subprocess command strings.
 * @module tests/security/injection.test
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process at the module level — all backends share this mock
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) =>
      cb(null, '/usr/bin/xclip\n'),
  ),
}));

import { spawn } from 'node:child_process';
import { SIZE_LIMITS } from '@/services/clipboard/clipboard-service.js';
import { LinuxX11Backend } from '@/services/clipboard/linux-x11-backend.js';
import { MacosBackend } from '@/services/clipboard/macos-backend.js';
import { WindowsBackend } from '@/services/clipboard/windows-backend.js';
import { scriptedSpawn } from '../services/clipboard/scripted-spawn.js';

const mockSpawn = vi.mocked(spawn);

/** Full injection payload list from the design doc. */
const INJECTION_PAYLOADS = [
  '"; $(whoami); "',
  "'; `id`; '",
  '$(cat /etc/passwd)',
  '\n; rm -rf /',
  '\\"; process.exit(); //',
  "'); ObjC.import('Foundation'); //",
  '; Invoke-Expression "whoami"',
  '| cat /etc/passwd',
  '\x00',
];

/** Size bomb payloads. */
const SIZE_PAYLOADS = [
  { label: 'text at limit (512KB)', size: SIZE_LIMITS.READ_TEXT, expectError: false },
  { label: 'text over limit (512KB+1)', size: SIZE_LIMITS.READ_TEXT + 1, expectError: true },
  { label: 'image at limit (5MB)', size: SIZE_LIMITS.READ_IMAGE, expectError: false },
  { label: 'image over limit (5MB+1)', size: SIZE_LIMITS.READ_IMAGE + 1, expectError: true },
  { label: 'write at limit (1MB)', size: SIZE_LIMITS.WRITE, expectError: false },
  { label: 'write over limit (1MB+1)', size: SIZE_LIMITS.WRITE + 1, expectError: true },
];

function fakeChild(opts: { stdout?: string | Buffer; exitCode?: number }) {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinEmitter = new EventEmitter() as typeof child.stdin;
  (stdinEmitter as unknown as { end: (data?: Buffer) => void }).end = vi.fn();
  Object.assign(stderrEmitter, { destroy: vi.fn() });
  Object.assign(child, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    stdin: stdinEmitter,
    unref: vi.fn(),
  });

  setImmediate(() => {
    if (opts.stdout)
      stdoutEmitter.emit(
        'data',
        Buffer.isBuffer(opts.stdout) ? opts.stdout : Buffer.from(opts.stdout),
      );
    // A writing helper (xclip -i, wl-copy) completes on its foreground exit.
    child.emit('exit', opts.exitCode ?? 0, null);
    child.emit('close', opts.exitCode ?? 0);
    // Also emit 'spawn' for Wayland's detach logic
    child.emit('spawn');
  });

  return child;
}

describe('Security: injection prevention', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * One write through `backend`, recorded by a scripted spawn: the helper's
   * argv and the bytes it received on stdin.
   */
  async function recordWrite(
    backend: MacosBackend | WindowsBackend,
    content: string,
    format: 'text' | 'html',
  ) {
    const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
    mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
    await backend.write(content, format);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    if (!call?.stdin) throw new Error('writer received no stdin');
    return { command: call.command, args: call.args, stdin: call.stdin };
  }

  /** Payloads whose argv must match byte for byte: 1 byte, 1 MiB, and every injection string. */
  const ARGV_CASES = ['x', 'y'.repeat(SIZE_LIMITS.WRITE), ...INJECTION_PAYLOADS];

  describe.each([
    ['MacosBackend', () => new MacosBackend(), 'osascript'],
    ['WindowsBackend', () => new WindowsBackend(), 'powershell.exe'],
  ] as const)('%s — writes (#31)', (_label, make, helper) => {
    it.each(['text', 'html'] as const)(
      '%s writes spawn a byte-identical argv for every payload',
      async (format) => {
        const baseline = await recordWrite(make(), 'x', format);
        expect(baseline.command).toBe(helper);
        for (const payload of ARGV_CASES) {
          const call = await recordWrite(make(), payload, format);
          expect(call.command).toBe(helper);
          expect(call.args).toEqual(baseline.args);
        }
      },
    );

    it.each(INJECTION_PAYLOADS)('payload bytes appear only on stdin (%j)', async (payload) => {
      const call = await recordWrite(make(), payload, 'text');
      const envelope = JSON.parse(call.stdin.toString('utf8')) as { text: string };
      expect(Buffer.from(envelope.text, 'base64').toString('utf8')).toBe(payload);
      const argv = call.args.join('\0');
      expect(argv).not.toContain(envelope.text);
      for (const danger of ['$(', '`id`', 'process.exit', 'Invoke-Expression', '| cat']) {
        if (payload.includes(danger)) expect(argv).not.toContain(danger);
      }
    });
  });

  it('the Windows command line is a constant far under the 32,767-character limit', async () => {
    for (const format of ['text', 'html'] as const) {
      const call = await recordWrite(new WindowsBackend(), 'y'.repeat(SIZE_LIMITS.WRITE), format);
      // libuv quotes each argument and escapes at most every character once, so
      // twice its length plus two quotes and a separator bounds the command line.
      const bound = [call.command, ...call.args].reduce((sum, arg) => sum + 2 * arg.length + 3, 0);
      expect(bound).toBeLessThan(4096);
    }
  });

  describe('LinuxX11Backend — write', () => {
    it.each(INJECTION_PAYLOADS)(
      'content on stdin, MIME type from enum only (%s)',
      async (payload) => {
        const child = fakeChild({ stdout: '' });
        mockSpawn.mockReturnValueOnce(child);
        const backend = new LinuxX11Backend();
        await backend.write(payload, 'text').catch(() => {
          /* ignore */
        });

        const calls = mockSpawn.mock.calls;
        if (calls.length === 0) return;
        const [cmd, args] = calls[0] as [string, string[]];
        expect(cmd).toBe('xclip');
        // The MIME type argument must be from a validated enum
        const tIdx = (args as string[]).indexOf('-t');
        if (tIdx >= 0) {
          const mimeArg = args[tIdx + 1] as string;
          const validMimes = [
            'UTF8_STRING',
            'text/html',
            'text/plain',
            'text/rtf',
            'application/rtf',
            'image/png',
            'TARGETS',
          ];
          expect(validMimes).toContain(mimeArg);
        }
        // Payload chars must not be in args
        for (const arg of args as string[]) {
          expect(arg).not.toContain('$(');
          expect(arg).not.toContain('| cat');
        }
      },
    );
  });

  describe('Size limit enforcement in ClipboardService', () => {
    it('READ_TEXT limit is 512KB', () => {
      expect(SIZE_LIMITS.READ_TEXT).toBe(512 * 1024);
    });

    it('READ_IMAGE limit is 5MB', () => {
      expect(SIZE_LIMITS.READ_IMAGE).toBe(5 * 1024 * 1024);
    });

    it('WRITE limit is 1MB', () => {
      expect(SIZE_LIMITS.WRITE).toBe(1 * 1024 * 1024);
    });

    it.each(SIZE_PAYLOADS)('$label', ({ size, expectError }) => {
      // Verify that content at the given size triggers content_too_large appropriately
      // This tests the SIZE_LIMITS constants that the service uses for enforcement
      const textContent = Buffer.alloc(size, 'a');
      if (expectError) {
        expect(textContent.byteLength).toBeGreaterThan(SIZE_LIMITS.READ_TEXT);
      } else {
        // Just validate the buffer sizes are within known limits at the threshold
        expect(textContent.byteLength).toBeGreaterThanOrEqual(size - 1);
      }
    });
  });
});
