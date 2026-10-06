import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { TOOL_LIMITS } from '@prospero/tools';
import type { ToolResult } from '@prospero/core';
import { boundOutput, throwIfAborted } from './limits';

const controlledPath = (home: string) =>
  [
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    join(home, '.bun', 'bin'),
  ].join(delimiter);

class OutputWindow {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private total = 0;
  constructor(private readonly cap: number) {}
  append(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.head.length < this.cap / 2)
      this.head = Buffer.concat([this.head, chunk.subarray(0, this.cap / 2 - this.head.length)]);
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-this.cap / 2);
  }
  get truncated(): boolean {
    return this.total > this.cap;
  }
  text(): string {
    if (this.total <= this.cap / 2) return this.head.toString('utf8');
    if (this.total <= this.cap)
      return Buffer.concat([
        this.head,
        this.tail.subarray(this.head.length + this.tail.length - this.total),
      ]).toString('utf8');
    return `${this.head.toString('utf8')}\n… output truncated …\n${this.tail.toString('utf8')}`;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** POSIX process groups make cancellation cover grandchildren, including shell pipelines. */
export async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolResult> {
  throwIfAborted(signal);
  if (process.platform === 'win32')
    throw new Error('Shell tools require a POSIX host in Prospero v0.1.');
  const stdout = new OutputWindow(TOOL_LIMITS.outputBytes / 2 - 512);
  const stderr = new OutputWindow(TOOL_LIMITS.outputBytes / 2 - 512);
  const home = homedir();
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Never inherit provider API keys, tokens or shell startup variables.
    env: {
      PATH: controlledPath(home),
      HOME: home,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      PWD: cwd,
    },
  });
  let timedOut = false;
  let spawnError: Error | undefined;
  let cleanup: Promise<void> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): Promise<void> => {
    if (cleanup) return cleanup;
    const pid = child.pid;
    cleanup = new Promise<void>((resolve, reject) => {
      if (!pid) {
        resolve();
        return;
      }
      try {
        if (!signalGroup(pid, 'SIGTERM')) {
          resolve();
          return;
        }
        // Always await this escalation; the direct shell can exit before a stubborn grandchild.
        killTimer = setTimeout(() => {
          try {
            signalGroup(pid, 'SIGKILL');
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 150);
      } catch (error) {
        reject(error);
      }
    });
    return cleanup;
  };
  const onAbort = () => {
    void terminate();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, timeoutMs);
  child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
  // Cleanup also covers background processes on otherwise successful shell completion.
  child.on('exit', () => {
    void terminate();
  });
  const closed = new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('close', (code, exitSignal) => resolve({ code, exitSignal }));
    },
  );
  if (signal.aborted) onAbort();
  try {
    const { code, exitSignal } = await closed;
    if (cleanup) await cleanup;
    throwIfAborted(signal);
    if (spawnError) throw new Error(`Failed to start shell: ${spawnError.message}`);
    const status = timedOut
      ? `Timed out after ${timeoutMs} ms; process group terminated.`
      : `Exit code: ${code ?? 'none'}${exitSignal ? ` (signal ${exitSignal})` : ''}`;
    const bounded = boundOutput(`stdout:\n${stdout.text()}\nstderr:\n${stderr.text()}\n${status}`);
    return {
      ...bounded,
      exitCode: code,
      isError: timedOut || code !== 0,
      truncated: bounded.truncated || stdout.truncated || stderr.truncated,
    };
  } finally {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener('abort', onAbort);
  }
}
