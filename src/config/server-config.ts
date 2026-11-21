/**
 * @fileoverview Server-specific config for clipboard-mcp-server. Parses the
 * `CLIPBOARD_*` environment variables that govern which tools this deployment
 * registers, separately from the framework's own core config.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * `z.stringbool()` accepts true/false/1/0/yes/no/on/off and the like
 * (case-insensitive) and rejects anything else at startup rather than coercing
 * it — `z.coerce.boolean()` would turn the string `"false"` into `true`, leaving
 * the flag impossible to switch off from the environment. Its rejection names
 * the accepted values, which the startup banner then shows.
 *
 * parseEnvConfig normalizes blank and unsubstituted placeholder values to unset;
 * z.stringbool() itself rejects those values.
 */
const ServerConfigSchema = z.object({
  readOnly: z
    .stringbool()
    .default(false)
    .describe(
      'Serve the clipboard read-only. When true, clipboard_write is absent from tools/list and uncallable, but listed as disabled in the server manifest, landing page, and startup log. Defaults to false.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parse (once) and return this server's own configuration. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    readOnly: 'CLIPBOARD_READ_ONLY',
  });
  return _config;
}

/**
 * Read `CLIPBOARD_READ_ONLY` without throwing, for the registration choice made
 * before `createApp()` runs. An unrecognized value reads as `false`; that never
 * reaches a client, because `getServerConfig()` in `setup()` then fails startup
 * behind the configuration-error banner. Blank and placeholder values also read
 * as `false`, which matches the default `getServerConfig()` gives them as unset.
 */
export function peekReadOnly(): boolean {
  const parsed = ServerConfigSchema.shape.readOnly.safeParse(process.env.CLIPBOARD_READ_ONLY);
  return parsed.success && parsed.data;
}

/** Test hook to reset the cached config. Not used at runtime. */
export function resetServerConfig(): void {
  _config = undefined;
}
