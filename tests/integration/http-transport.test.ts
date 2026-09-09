/**
 * @fileoverview HTTP transport integration tests — boots the built server and
 * asserts the behavior only the real transport exhibits: session-mode defaults,
 * the request-body cap that stands between a client and `clipboard_write`'s
 * declared size error, and which tools a read-only deployment registers.
 *
 * @module tests/integration/http-transport.test
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildServer,
  type Connection,
  connect,
  createTempDir,
  type InitializeResult,
  initialize,
  type JsonRpcResponse,
  type RunningServer,
  resultOf,
  startServer,
} from './harness.js';

/** The tool's own write ceiling, mirrored from `SIZE_LIMITS.WRITE`. */
const WRITE_LIMIT = 1024 * 1024;

/**
 * Worst-case JSON escaping: a control character with no short escape serializes
 * as `\uXXXX` — 6 wire bytes for 1 UTF-8 source byte. A maximal write built
 * from these is the largest body a valid call can produce.
 */
const escapeHeavy = (bytes: number): string => String.fromCharCode(1).repeat(bytes);

interface ToolListResult {
  tools: { name: string }[];
}

async function listToolNames(client: Connection): Promise<string[]> {
  const response = await client.call('tools/list', {});
  return resultOf<ToolListResult>(response)
    .tools.map((t) => t.name)
    .sort();
}

async function callWrite(client: Connection, content: string): Promise<JsonRpcResponse> {
  return await client.call('tools/call', {
    name: 'clipboard_write',
    arguments: { content, format: 'text' },
  });
}

beforeAll(() => {
  buildServer();
}, 180_000);

describe('default HTTP launch', () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('initializes without minting a session id', async () => {
    const response = await initialize(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('serves instructions that name every supported platform', async () => {
    const result = resultOf<InitializeResult>(await initialize(server.url));
    expect(result.instructions).toBeDefined();
    const instructions = result.instructions ?? '';
    expect(instructions).toContain('macOS');
    expect(instructions).toContain('Linux');
    expect(instructions).toContain('Windows');
    expect(instructions).toContain('no API key');
    expect(instructions).not.toMatch(/\(macOS; no API key\)/);
  });

  it('keeps the single-live-slot guidance intact', async () => {
    const result = resultOf<InitializeResult>(await initialize(server.url));
    const instructions = result.instructions ?? '';
    expect(instructions).toContain('There is no history');
    expect(instructions).toContain('single live slot');
    expect(instructions).toContain('call clipboard_inspect first');
    expect(instructions).toContain('format "auto"');
    expect(instructions).toContain('clipboard_write replaces it');
  });

  it('registers all three clipboard tools', async () => {
    expect(await listToolNames(await connect(server.url))).toEqual([
      'clipboard_inspect',
      'clipboard_read',
      'clipboard_write',
    ]);
  });

  it('lets the largest valid write reach the handler', async () => {
    const response = await callWrite(await connect(server.url), escapeHeavy(WRITE_LIMIT));
    expect(response.status).toBe(200);
    const result = resultOf<{
      isError?: boolean;
      structuredContent?: { byteSize?: number; format?: string };
    }>(response);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ format: 'text', byteSize: WRITE_LIMIT });
  });

  it('answers the first oversized write with the declared content_too_large envelope', async () => {
    const response = await callWrite(await connect(server.url), escapeHeavy(WRITE_LIMIT + 1));
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('Request body exceeds');

    const result = resultOf<{
      content?: { text?: string; type: string }[];
      isError?: boolean;
      structuredContent?: { error?: { data?: Record<string, unknown> } };
    }>(response);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.data).toMatchObject({
      bytes: WRITE_LIMIT + 1,
      limit: WRITE_LIMIT,
      reason: 'content_too_large',
      recovery: { hint: expect.stringContaining('Truncate or summarize') },
    });
    const text = result.content?.map((block) => block.text ?? '').join('\n') ?? '';
    expect(text).toContain('Truncate or summarize');
  });
});

describe('operator-selected stateful sessions', () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer({ env: { MCP_SESSION_MODE: 'stateful' } });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('mints a session id on initialize', async () => {
    const response = await initialize(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeTruthy();
  });
});

describe('read-only deployment', () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer({ env: { CLIPBOARD_READ_ONLY: 'true' } });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('omits clipboard_write from tools/list', async () => {
    expect(await listToolNames(await connect(server.url))).toEqual([
      'clipboard_inspect',
      'clipboard_read',
    ]);
  });

  it('refuses a clipboard_write call as an unknown tool', async () => {
    const response = await callWrite(await connect(server.url), 'hello');
    const body = response.text.toLowerCase();
    expect(body).toMatch(/not found|unknown tool|-32601/);
    expect(body).not.toContain('"bytesize"');
  });

  it('drops write guidance from the instructions', async () => {
    const result = resultOf<InitializeResult>(await initialize(server.url));
    const instructions = result.instructions ?? '';
    expect(instructions).not.toContain('clipboard_write');
    expect(instructions).toContain('clipboard_inspect');
    expect(instructions).toContain('macOS');
  });
});

describe('invalid CLIPBOARD_READ_ONLY', () => {
  it('fails startup naming the variable', async () => {
    await expect(startServer({ env: { CLIPBOARD_READ_ONLY: 'maybe' } })).rejects.toThrow(
      /CLIPBOARD_READ_ONLY/,
    );
  }, 60_000);
});

describe('MCP_HTTP_MAX_BODY_BYTES precedence', () => {
  /** Comfortably over the 1024-byte cap the .env files below set. */
  const PADDING = 4096;

  it('lets a .env value beat the server default', async () => {
    const cwd = createTempDir();
    writeFileSync(join(cwd, '.env'), 'MCP_HTTP_MAX_BODY_BYTES=1024\n', 'utf8');
    const server = await startServer({ cwd });
    try {
      const response = await initialize(server.url, { clientNamePadding: PADDING });
      expect(response.status).toBe(413);
      expect(response.text).toContain('1024-byte limit');
    } finally {
      await server.stop();
    }
  }, 60_000);

  it('lets the shell environment beat a .env value', async () => {
    const cwd = createTempDir();
    writeFileSync(join(cwd, '.env'), 'MCP_HTTP_MAX_BODY_BYTES=1024\n', 'utf8');
    const server = await startServer({ cwd, env: { MCP_HTTP_MAX_BODY_BYTES: '7340032' } });
    try {
      const response = await initialize(server.url, { clientNamePadding: PADDING });
      expect(response.status).toBe(200);
    } finally {
      await server.stop();
    }
  }, 60_000);
});
