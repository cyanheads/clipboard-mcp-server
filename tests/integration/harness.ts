/**
 * @fileoverview Integration-test harness — boots the built server over the real
 * HTTP transport in a child process and speaks JSON-RPC to it.
 *
 * The child gets an explicit environment (never the runner's inherited one) so a
 * stray `MCP_*` variable in the developer's shell cannot decide what a test
 * observes. `PATH` is prefixed with a stub bin directory whose `pbcopy`/`xclip`
 * scripts swallow stdin, so clipboard writes exercised here never touch the real
 * system clipboard.
 *
 * @module tests/integration/harness
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const serverEntry = join(projectRoot, 'dist', 'index.js');

/** Protocol revision that carries HTTP sessions; the 2026-07-28 era has none. */
export const SESSIONED_PROTOCOL = '2025-11-25';

/** Write an executable shell script. */
function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

/**
 * Create a bin directory of clipboard stubs. Writers swallow stdin, readers
 * emit nothing — enough for every backend this suite exercises without
 * mutating the developer's real clipboard.
 */
export function createClipboardStubBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clipboard-mcp-stub-'));
  for (const writer of ['pbcopy', 'xclip', 'wl-copy']) {
    writeScript(join(dir, writer), 'cat > /dev/null');
  }
  for (const reader of ['pbpaste', 'wl-paste']) {
    writeScript(join(dir, reader), "printf ''");
  }
  return dir;
}

/**
 * Compile `src/` so the child process runs this working tree rather than a
 * stale `dist/`. Integration tests assert on transport behavior that only the
 * built entry point exhibits, so a stale build is a false green.
 */
export function buildServer(): void {
  execFileSync('bun', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });
}

/** Create an empty temp directory usable as a server working directory. */
export function createTempDir(prefix = 'clipboard-mcp-cwd-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface RunningServer {
  /** Everything the child wrote to stdout and stderr so far. */
  log: () => string;
  /** Terminate the child and wait for it to exit. */
  stop: () => Promise<void>;
  /** Bound MCP endpoint, read off the child's own listen line. */
  url: string;
}

export interface StartServerOptions {
  /** Working directory — set it to a temp dir to control `.env` discovery. */
  cwd?: string;
  /** Extra environment for the child. Overrides the harness defaults. */
  env?: Record<string, string>;
  /** Seconds to wait for the listen line. */
  timeoutSeconds?: number;
}

/**
 * Build, already done by the caller, is assumed: this spawns `dist/index.js`
 * directly and resolves once the transport logs its bound URL.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const { cwd = projectRoot, env = {}, timeoutSeconds = 30 } = options;
  const stubBin = createClipboardStubBin();
  const childEnv: Record<string, string> = {
    PATH: `${stubBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: process.env.HOME ?? tmpdir(),
    LOGS_DIR: createTempDir('clipboard-mcp-logs-'),
    MCP_TRANSPORT_TYPE: 'http',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: String(3100 + Math.floor(Math.random() * 700)),
    MCP_LOG_LEVEL: 'info',
    DISPLAY: process.env.DISPLAY ?? ':0',
    ...env,
  };

  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const collect = (chunk: Buffer) => {
    output += chunk.toString('utf8');
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
      }, 3000).unref();
    });
  };

  const url = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      void stop();
      reject(new Error(`server did not start within ${timeoutSeconds}s. Log:\n${output}`));
    }, timeoutSeconds * 1000);
    deadline.unref();

    const check = () => {
      const match = /listening at (http:\/\/[^\s"]+\/mcp)/.exec(output);
      if (match?.[1]) {
        clearTimeout(deadline);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`server exited with code ${code} before listening. Log:\n${output}`));
    });
  });

  return { url, log: () => output, stop };
}

export interface JsonRpcResponse {
  headers: Headers;
  json: Record<string, unknown> | undefined;
  status: number;
  text: string;
}

/**
 * Extract the JSON-RPC response from either a plain JSON body or an SSE stream.
 * A tool call's stream also carries `notifications/message` frames from
 * `ctx.log`, so pick the frame that actually answers the request — the one
 * carrying `result` or `error`.
 */
function decodeBody(text: string): Record<string, unknown> | undefined {
  const frames = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6));
  const candidates = frames.length > 0 ? frames : [text];

  let lastParsed: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      continue;
    }
    lastParsed = parsed;
    if ('result' in parsed || 'error' in parsed) return parsed;
  }
  return lastParsed;
}

/** POST one JSON-RPC message and decode whatever comes back. */
export async function rpc(
  url: string,
  body: unknown,
  init: { protocol?: string; sessionId?: string } = {},
): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (init.protocol) headers['MCP-Protocol-Version'] = init.protocol;
  if (init.sessionId) headers['Mcp-Session-Id'] = init.sessionId;

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: decodeBody(text) };
}

/** Run `initialize` and follow it with `notifications/initialized`. */
export async function initialize(
  url: string,
  options: { clientNamePadding?: number; protocol?: string } = {},
): Promise<JsonRpcResponse> {
  const protocol = options.protocol ?? SESSIONED_PROTOCOL;
  const name = `field-test${'x'.repeat(options.clientNamePadding ?? 0)}`;
  const response = await rpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name, version: '1.0.0' },
    },
  });
  const sessionId = response.headers.get('mcp-session-id');
  if (response.status < 400) {
    await rpc(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { protocol, ...(sessionId ? { sessionId } : {}) },
    );
  }
  return response;
}

/** An initialized client bound to whatever session the server did or did not mint. */
export interface Connection {
  call: (method: string, params: Record<string, unknown>) => Promise<JsonRpcResponse>;
  initialize: JsonRpcResponse;
  sessionId: string | null;
}

/**
 * Initialize and return a caller that carries the session id when there is one.
 * Lets a test assert tool behavior without knowing the server's session mode.
 */
export async function connect(url: string, protocol = SESSIONED_PROTOCOL): Promise<Connection> {
  const response = await initialize(url, { protocol });
  const sessionId = response.headers.get('mcp-session-id');
  let nextId = 2;
  return {
    initialize: response,
    sessionId,
    call: (method, params) =>
      rpc(
        url,
        { jsonrpc: '2.0', id: nextId++, method, params },
        { protocol, ...(sessionId ? { sessionId } : {}) },
      ),
  };
}

/** Shape of the `result` object an `initialize` call returns. */
export interface InitializeResult {
  instructions?: string;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
}

/** Read the `result` off a decoded JSON-RPC response. */
export function resultOf<T>(response: JsonRpcResponse): T {
  const result = (response.json as { result?: T } | undefined)?.result;
  if (result === undefined) {
    throw new Error(`no JSON-RPC result in response: ${response.text.slice(0, 500)}`);
  }
  return result;
}
