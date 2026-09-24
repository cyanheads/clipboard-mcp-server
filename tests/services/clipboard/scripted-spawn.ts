/**
 * @fileoverview Scripted `child_process.spawn` fake. Each spawn is routed by
 * command and arguments to a canned helper outcome, so a test states what the
 * native helper does for a given invocation instead of the order the backend
 * happens to call it in.
 * @module tests/services/clipboard/scripted-spawn
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

/** What one native helper invocation does. */
export interface HelperReply {
  /** Spawn failure code (e.g. `ENOENT`), emitted as the child's `error` event. */
  errorCode?: string;
  /** Exit status. Defaults to 0. */
  exitCode?: number;
  /**
   * The helper forks a background process that inherits the stdio pipes, as
   * `xclip -i` and `wl-copy` do: the foreground process exits, but the pipes
   * stay open, so `exit` fires and `close` never does.
   */
  forks?: boolean;
  stderr?: string;
  stdout?: string | Buffer;
}

/** Decides a helper's outcome from the command line it was spawned with. */
export type HelperScript = (command: string, args: readonly string[]) => HelperReply;

/** One recorded spawn. */
export interface SpawnCall {
  args: string[];
  command: string;
  /** Bytes the backend wrote to the child's stdin, once it ended the stream. */
  stdin: Buffer | undefined;
}

type StdioOption = 'pipe' | 'ignore' | 'inherit';

/**
 * Build a `spawn` implementation driven by `script`. Pass it to
 * `vi.mocked(spawn).mockImplementation(...)`; `calls` records every invocation.
 */
export function scriptedSpawn(script: HelperScript) {
  const calls: SpawnCall[] = [];

  const spawnImpl = (command: string, args: readonly string[], options?: { stdio?: unknown }) => {
    const call: SpawnCall = { command, args: [...args], stdin: undefined };
    calls.push(call);
    const reply = script(command, args);
    const stdio = (Array.isArray(options?.stdio) ? options.stdio : []) as StdioOption[];
    const piped = (index: number) => (stdio[index] ?? 'pipe') === 'pipe';

    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: PassThrough | null;
      stdin: Writable | null;
      stdout: PassThrough | null;
      unref: () => void;
    };
    child.pid = 4242;
    child.unref = () => undefined;
    child.stdout = piped(1) ? new PassThrough() : null;
    child.stderr = piped(2) ? new PassThrough() : null;
    if (piped(0)) {
      const chunks: Buffer[] = [];
      child.stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          call.stdin = Buffer.concat(chunks);
          callback();
        },
      });
    } else {
      child.stdin = null;
    }

    setImmediate(() => {
      if (reply.errorCode) {
        child.emit(
          'error',
          Object.assign(new Error(`spawn ${command} ${reply.errorCode}`), {
            code: reply.errorCode,
          }),
        );
        return;
      }
      if (reply.stdout !== undefined && child.stdout) child.stdout.write(reply.stdout);
      if (reply.stderr && child.stderr) child.stderr.write(reply.stderr);
      const code = reply.exitCode ?? 0;
      if (reply.forks) {
        // The forked background process still holds stdout/stderr open.
        setImmediate(() => child.emit('exit', code, null));
        return;
      }
      child.stdout?.end();
      child.stderr?.end();
      setImmediate(() => {
        child.emit('exit', code, null);
        setImmediate(() => child.emit('close', code, null));
      });
    });

    return child;
  };

  return { calls, spawnImpl };
}

/** Last `-t <type>` argument of a helper invocation, if any. */
export function requestedType(args: readonly string[]): string | undefined {
  const index = args.lastIndexOf('-t');
  return index >= 0 ? args[index + 1] : undefined;
}
