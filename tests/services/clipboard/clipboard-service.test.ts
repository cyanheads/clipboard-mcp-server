/**
 * @fileoverview Tests for platform-specific clipboard backend selection.
 * @module tests/services/clipboard/clipboard-service.test
 */

import { execFile } from 'node:child_process';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import {
  getClipboardService,
  initClipboardService,
} from '@/services/clipboard/clipboard-service.js';
import { LinuxWaylandBackend } from '@/services/clipboard/linux-wayland-backend.js';
import { LinuxX11Backend } from '@/services/clipboard/linux-x11-backend.js';
import { MacosBackend } from '@/services/clipboard/macos-backend.js';
import type { ClipboardBackend } from '@/services/clipboard/types.js';
import { WindowsBackend } from '@/services/clipboard/windows-backend.js';

const mockExecFile = vi.mocked(execFile);

function selectedBackend(): ClipboardBackend {
  return (getClipboardService() as unknown as { backend: ClipboardBackend }).backend;
}

function mockToolAvailable(): void {
  mockExecFile.mockImplementation((_file, _args, callback) => {
    (callback as (error: null, stdout: string, stderr: string) => void)(null, '', '');
    return {} as ReturnType<typeof execFile>;
  });
}

async function initService(): Promise<void> {
  await initClipboardService({} as AppConfig, {} as StorageService);
}

describe('ClipboardService backend selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('selects macOS unconditionally without probing PATH', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    await initService();

    expect(selectedBackend()).toBeInstanceOf(MacosBackend);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('selects Wayland after probing wl-paste with Unix which', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    vi.stubEnv('DISPLAY', '');
    mockToolAvailable();

    await initService();

    expect(selectedBackend()).toBeInstanceOf(LinuxWaylandBackend);
    expect(mockExecFile).toHaveBeenCalledWith('which', ['wl-paste'], expect.any(Function));
  });

  it('selects X11 after probing xclip with Unix which', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    vi.stubEnv('DISPLAY', ':0');
    mockToolAvailable();

    await initService();

    expect(selectedBackend()).toBeInstanceOf(LinuxX11Backend);
    expect(mockExecFile).toHaveBeenCalledWith('which', ['xclip'], expect.any(Function));
  });

  it('selects Windows after finding powershell.exe with the native probe', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockExecFile.mockImplementation((file, args, callback) => {
      const error =
        file === 'where.exe' && args?.[0] === 'powershell.exe' ? null : new Error('missing');
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(error, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    await initService();

    expect(selectedBackend()).toBeInstanceOf(WindowsBackend);
    expect(mockExecFile).toHaveBeenCalledWith(
      'where.exe',
      ['powershell.exe'],
      expect.any(Function),
    );
    expect(mockExecFile).not.toHaveBeenCalledWith('which', expect.anything(), expect.any(Function));
  });

  it('reports actionable guidance when the native Windows probe fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockExecFile.mockImplementation((_file, _args, callback) => {
      (callback as (error: Error, stdout: string, stderr: string) => void)(
        new Error('missing'),
        '',
        '',
      );
      return {} as ReturnType<typeof execFile>;
    });

    await expect(initService()).rejects.toMatchObject({
      message: 'powershell.exe not found. Requires PowerShell 5.1+ (built-in on Windows 10+).',
      data: {
        platform: 'win32',
        recovery: {
          hint: 'Ensure PowerShell 5.1+ is available. It is built-in on Windows 10 and later.',
        },
      },
    });
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      'where.exe',
      ['powershell.exe'],
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      'where.exe',
      ['powershell'],
      expect.any(Function),
    );
  });
});
