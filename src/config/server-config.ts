/**
 * @fileoverview Server-specific config for clipboard-mcp-server. Parses the
 * `CLIPBOARD_*` environment variables that govern which tools this deployment
 * registers, separately from the framework's own core config.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Boolean env flag parser. Accepts true/false/1/0/yes/no/on/off (case-insensitive)
 * and rejects anything else at startup rather than coercing it — `z.coerce.boolean()`
 * would turn the string `"false"` into `true`, leaving the flag impossible to
 * switch off from the environment.
 *
 * parseEnvConfig normalizes blank and unsubstituted placeholder values to unset;
 * z.stringbool() itself rejects those values.
 */
const envBoolean = z.union([z.boolean(), z.stringbool()]);

const ServerConfigSchema = z.object({
  readOnly: envBoolean
    .default(false)
    .describe(
      'Serve the clipboard read-only. When true, clipboard_write is not registered: it stays visible on the manifest and landing page but is absent from tools/list and uncallable. Defaults to false.',
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

/** Test hook to reset the cached config. Not used at runtime. */
export function resetServerConfig(): void {
  _config = undefined;
}
