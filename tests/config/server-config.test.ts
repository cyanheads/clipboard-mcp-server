/**
 * @fileoverview Unit tests for the server-config schema — env-var resolution,
 * boolean parsing, the default, and the startup failure an unrecognized value
 * produces. Exercises the real `parseEnvConfig` path, not a stand-in.
 *
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, peekReadOnly, resetServerConfig } from '@/config/server-config.js';

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

  it('treats an unsubstituted CLIPBOARD_READ_ONLY placeholder as unset', () => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', `\${CLIPBOARD_READ_ONLY}`);
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

  it('rejects an unrecognized value, naming the variable and the values it accepts', () => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', 'maybe');
    expect(() => getServerConfig()).toThrow(
      /CLIPBOARD_READ_ONLY \(readOnly\): Invalid option: expected one of "true"\|"1"\|"yes"\|"on"/,
    );
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

describe('peekReadOnly', () => {
  it.each(['true', '1', 'yes', 'on', 'TRUE', 'On'])('reads %s as true', (value) => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', value);
    expect(peekReadOnly()).toBe(true);
  });

  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['0', '0'],
    ['empty', ''],
    ['whitespace-only', '  '],
    ['an unsubstituted placeholder', `\${user_config.CLIPBOARD_READ_ONLY}`],
  ])('reads %s as false', (_label, value) => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', value as string);
    expect(peekReadOnly()).toBe(false);
  });

  it.each(['maybe', ' true', 'true1'])(
    'reads the unrecognized value %j as false without throwing, where getServerConfig rejects it',
    (value) => {
      vi.stubEnv('CLIPBOARD_READ_ONLY', value);
      expect(peekReadOnly()).toBe(false);
      expect(() => getServerConfig()).toThrow(/CLIPBOARD_READ_ONLY/);
    },
  );

  it.each([
    'true',
    'false',
    'yes',
    'OFF',
    'y',
    'disabled',
    '',
    ' ',
    `\${user_config.CLIPBOARD_READ_ONLY}`,
    ` \${X} `,
  ])('agrees with getServerConfig on the accepted value %j', (value) => {
    vi.stubEnv('CLIPBOARD_READ_ONLY', value);
    expect(peekReadOnly()).toBe(getServerConfig().readOnly);
  });
});
