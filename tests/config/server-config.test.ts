/**
 * @fileoverview Unit tests for the server-config schema — env-var resolution,
 * boolean parsing, the default, and the startup failure an unrecognized value
 * produces. Exercises the real `parseEnvConfig` path, not a stand-in.
 *
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

beforeEach(() => {
  resetServerConfig();
  vi.stubEnv('CLIPBOARD_READ_ONLY', undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

describe('getServerConfig', () => {
  it('defaults readOnly to false when CLIPBOARD_READ_ONLY is unset', () => {
    expect(getServerConfig().readOnly).toBe(false);
  });

  it('treats an empty CLIPBOARD_READ_ONLY as unset', () => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', '');
    expect(getServerConfig().readOnly).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE', 'On'])('parses %s as true', (value) => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', value);
    expect(getServerConfig().readOnly).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'FALSE', 'Off'])('parses %s as false', (value) => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', value);
    expect(getServerConfig().readOnly).toBe(false);
  });

  it('rejects an unrecognized value, naming the variable', () => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', 'maybe');
    expect(() => getServerConfig()).toThrow(/CLIPBOARD_READ_ONLY/);
  });

  it('caches the parsed config until it is reset', () => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', 'true');
    expect(getServerConfig().readOnly).toBe(true);

    vi.stubEnv('CLIPBOARD_READ_ONLY', 'false');
    expect(getServerConfig().readOnly).toBe(true);

    resetServerConfig();
    expect(getServerConfig().readOnly).toBe(false);
  });
});
