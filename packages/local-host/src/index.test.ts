import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolHost } from '@prospero/core';
import { createLocalToolHost, TOOL_LIMITS } from './index';
import { boundOutput } from './limits';
import { runShell } from './shell';

let fixture: string;
let workspace: string;
let external: string;
let host: ToolHost;
const signal = () => new AbortController().signal;
const call = (name: string, args: object) => ({
  id: 'call-1',
  name,
  arguments: JSON.stringify(args),
});
const prepare = (name: string, args: object = {}, toolHost = host) =>
  toolHost.prepare(call(name, args), signal());
const run = async (name: string, args: object = {}, toolHost = host) =>
  (await prepare(name, args, toolHost)).execute(signal());
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const supportedRuntimePaths = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  path.join(homedir(), '.bun', 'bin'),
];
const hasSupportedRuntime = (name: string) =>
  supportedRuntimePaths.some((directory) => existsSync(path.join(directory, name)));

beforeEach(async () => {
  // macOS /var and /tmp aliases are symlinks; fixtures deliberately use the canonical path.
  fixture = await mkdtemp(path.join(await realpath(tmpdir()), 'prospero-host-'));
  workspace = path.join(fixture, 'workspace');
  external = path.join(fixture, 'external');
  await mkdir(workspace);
  await mkdir(external);
  await writeFile(path.join(workspace, 'hello.txt'), 'first line\nneedle second line\n');
  await writeFile(path.join(external, 'secret.txt'), 'external secret');
  host = createLocalToolHost({ workspace });
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe('workspace and attachment boundaries', () => {
  test('reads real content, lists entries and searches literal contents', async () => {
    expect((await run('read_file', { path: 'hello.txt' })).content).toBe(
      'first line\nneedle second line\n',
    );
    expect(JSON.parse((await run('list_directory')).content).entries).toEqual([
      expect.objectContaining({ name: 'hello.txt', type: 'file' }),
    ]);
    const result = await run('search_files', { pattern: 'needle' });
    expect(result.content).toContain('"hello.txt":2: needle second line');
    expect((await run('search_files', { pattern: '.*' })).content).toBe('(no matches)');
  });

  test('reads use explicit configurable permission, writes and every shell command require one-time confirmation', async () => {
    expect((await prepare('read_file', { path: 'hello.txt' })).requiresPermission).toBe(false);
    const cautious = createLocalToolHost({ workspace, askBeforeReads: true });
    const read = await prepare('read_file', { path: 'hello.txt' }, cautious);
    expect(read.requiresPermission).toBe(true);
    expect(read.allowSession).toBe(true);
    const workspaceStat = await stat(workspace);
    expect(read.permissionKey).toBe(
      `read:workspace:${workspace}:${workspaceStat.dev}:${workspaceStat.ino}:${workspaceStat.mode}`,
    );
    for (const prepared of [
      await prepare('write_file', { path: 'new.txt', content: 'new' }),
      await prepare('shell', { command: 'pwd' }),
      await prepare('shell', { command: 'echo rm -rf' }),
    ]) {
      expect(prepared.requiresPermission).toBe(true);
      expect(prepared.allowSession).toBe(false);
    }
  });

  test.each(['../external/secret.txt', 'nested/../../external/secret.txt'])(
    'rejects traversal %s',
    async (input) => {
      await expect(prepare('read_file', { path: input })).rejects.toThrow('traversal');
      await expect(prepare('write_file', { path: input, content: 'bad' })).rejects.toThrow(
        'traversal',
      );
    },
  );

  test('rejects absolute paths outside the workspace and prefix sibling escapes', async () => {
    await expect(prepare('read_file', { path: path.join(external, 'secret.txt') })).rejects.toThrow(
      'outside',
    );
    await expect(prepare('list_directory', { path: `${workspace}-other` })).rejects.toThrow(
      'outside',
    );
    await expect(prepare('search_files', { path: external, pattern: 'secret' })).rejects.toThrow(
      'outside',
    );
  });

  test('explicit attachments grant only the exact file read, including with no workspace', async () => {
    const file = path.join(external, 'secret.txt');
    const attachments = createLocalToolHost({ attachments: [file], askBeforeReads: true });
    expect((await run('read_file', { path: file }, attachments)).content).toBe('external secret');
    const fileStat = await stat(file);
    expect((await prepare('read_file', { path: file }, attachments)).permissionKey).toBe(
      `read:attachment:${file}:${fileStat.dev}:${fileStat.ino}:${fileStat.mode}`,
    );
    await expect(
      prepare('read_file', { path: path.join(external, 'other.txt') }, attachments),
    ).rejects.toThrow('Attach');
    await expect(prepare('list_directory', { path: external }, attachments)).rejects.toThrow(
      'Attach',
    );
    await expect(
      prepare('write_file', { path: file, content: 'bad' }, attachments),
    ).rejects.toThrow('Attach');
    await expect(prepare('shell', { command: 'pwd' }, attachments)).rejects.toThrow('Attach');
  });

  test('rejects symlink leaves, symlink directories and attached symlink roots', async () => {
    await symlink(path.join(external, 'secret.txt'), path.join(workspace, 'linked.txt'));
    await symlink(external, path.join(workspace, 'linked-directory'));
    await expect(run('read_file', { path: 'linked.txt' })).rejects.toThrow('Symlink');
    await expect(run('read_file', { path: 'linked-directory/secret.txt' })).rejects.toThrow(
      'Symlink',
    );
    await expect(prepare('write_file', { path: 'linked.txt', content: 'bad' })).rejects.toThrow(
      'Symlink',
    );
    await expect(run('list_directory', { path: 'linked-directory' })).rejects.toThrow('Symlink');
    expect(JSON.parse((await run('list_directory')).content).entries).toContainEqual(
      expect.objectContaining({ name: 'linked.txt', type: 'symlink', sizeBytes: null }),
    );
    expect((await run('search_files', { pattern: 'secret' })).content).toBe('(no matches)');
    const alias = path.join(fixture, 'alias');
    await symlink(workspace, alias);
    await expect(
      prepare('list_directory', {}, createLocalToolHost({ workspace: alias })),
    ).rejects.toThrow('Symlink');
  });

  test('rejects prepared reads when a directory or root is swapped for a symlink', async () => {
    await mkdir(path.join(workspace, 'nested'));
    await writeFile(path.join(workspace, 'nested', 'file'), 'inside');
    const prepared = await prepare('read_file', { path: 'nested/file' });
    await rename(path.join(workspace, 'nested'), path.join(workspace, 'saved'));
    await symlink(external, path.join(workspace, 'nested'));
    await expect(prepared.execute(signal())).rejects.toThrow('Symlink');
    const list = await prepare('list_directory');
    await rename(workspace, path.join(fixture, 'old-workspace'));
    await mkdir(workspace);
    await expect(list.execute(signal())).rejects.toThrow('workspace changed');
  });

  test('workspace session grants bind to root identity across newly created hosts', async () => {
    const oldRead = await prepare('read_file', { path: 'hello.txt' });
    const sameRoot = await prepare('list_directory', {}, createLocalToolHost({ workspace }));
    expect(sameRoot.permissionKey).toBe(oldRead.permissionKey);
    await rename(workspace, path.join(fixture, 'old-workspace'));
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'hello.txt'), 'replacement workspace');
    const newRead = await prepare(
      'read_file',
      { path: 'hello.txt' },
      createLocalToolHost({ workspace }),
    );
    expect(newRead.permissionKey).not.toBe(oldRead.permissionKey);
    expect(newRead.permissionKey).toContain(`read:workspace:${workspace}:`);
    await expect(oldRead.execute(signal())).rejects.toThrow('workspace changed');
    expect((await newRead.execute(signal())).content).toBe('replacement workspace');
  });

  test('attachment session grants bind to exact file identity and reject stale prepared reads', async () => {
    const file = path.join(external, 'secret.txt');
    const attachments = createLocalToolHost({ attachments: [file], askBeforeReads: true });
    const oldRead = await prepare('read_file', { path: file }, attachments);
    const unchanged = await prepare(
      'read_file',
      { path: file },
      createLocalToolHost({ attachments: [file] }),
    );
    expect(unchanged.permissionKey).toBe(oldRead.permissionKey);
    await rename(file, path.join(external, 'old-secret.txt'));
    await writeFile(file, 'replacement attachment');
    const newRead = await prepare(
      'read_file',
      { path: file },
      createLocalToolHost({ attachments: [file] }),
    );
    expect(newRead.permissionKey).not.toBe(oldRead.permissionKey);
    await expect(oldRead.execute(signal())).rejects.toThrow('Attached file changed');
    await expect(prepare('read_file', { path: file }, attachments)).rejects.toThrow(
      'Attached file changed',
    );
    expect((await newRead.execute(signal())).content).toBe('replacement attachment');
  });

  test('bounds file, directory and search outputs and rejects binary/huge file reads', async () => {
    await writeFile(path.join(workspace, 'large.txt'), '中'.repeat(40_000));
    const read = await run('read_file', { path: 'large.txt' });
    expect(read.truncated).toBe(true);
    expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(TOOL_LIMITS.outputBytes);
    expect((await run('read_file', { path: 'hello.txt', maxBytes: 5 })).content).toBe('first');
    expect((await run('list_directory', { maxEntries: 1 })).truncated).toBe(true);
    await writeFile(path.join(workspace, 'binary'), Buffer.from([1, 0, 2]));
    await writeFile(path.join(workspace, 'huge'), 'needle'.repeat(50_000));
    await expect(run('read_file', { path: 'binary' })).rejects.toThrow('Binary');
    await expect(run('read_file', { path: 'huge' })).rejects.toThrow('exceeds');
    await writeFile(path.join(workspace, 'matches'), 'needle\n'.repeat(50));
    const search = await run('search_files', { pattern: 'needle', maxResults: 2 });
    expect(search.truncated).toBe(true);
    expect(Buffer.byteLength(search.content)).toBeLessThanOrEqual(TOOL_LIMITS.outputBytes);
    expect(search.content).not.toContain('"huge"');
  });

  test('errors for missing files, wrong kinds, absent parent directories and malformed calls', async () => {
    await expect(run('read_file', { path: 'missing' })).rejects.toThrow();
    await expect(run('read_file', { path: '.' })).rejects.toThrow('regular');
    await expect(run('list_directory', { path: 'hello.txt' })).rejects.toThrow('directory');
    await expect(prepare('write_file', { path: 'missing/child', content: 'x' })).rejects.toThrow();
    await expect(prepare('write_file', { path: '.', content: 'x' })).rejects.toThrow('regular');
    await expect(
      host.prepare({ id: 'x', name: 'read_file', arguments: '{' }, signal()),
    ).rejects.toThrow('JSON');
  });
});

describe('confirmed writes', () => {
  test('rejects hard-linked write targets so external content cannot be modified', async () => {
    await link(path.join(external, 'secret.txt'), path.join(workspace, 'hardlink.txt'));
    await expect(prepare('write_file', { path: 'hardlink.txt', content: 'bad' })).rejects.toThrow(
      'Hard-linked',
    );
    expect(await readFile(path.join(external, 'secret.txt'), 'utf8')).toBe('external secret');
    const prepared = await prepare('write_file', { path: 'hello.txt', content: 'bad' });
    await link(path.join(workspace, 'hello.txt'), path.join(external, 'linked-later'));
    await expect(prepared.execute(signal())).rejects.toThrow('Hard-linked');
    expect(await readFile(path.join(external, 'linked-later'), 'utf8')).toContain('first line');
  });

  test('previews mature unified diff without writing, then replaces real content and truncates old tails', async () => {
    const prepared = await prepare('write_file', { path: 'hello.txt', content: 'short\n' });
    expect(prepared.preview.before).toContain('first line');
    expect(prepared.preview.after).toBe('short\n');
    expect(prepared.preview.diff).toContain('-first line');
    expect(prepared.preview.diff).toContain('+short');
    expect(await readFile(path.join(workspace, 'hello.txt'), 'utf8')).toContain('needle');
    await prepared.execute(signal());
    expect(await readFile(path.join(workspace, 'hello.txt'), 'utf8')).toBe('short\n');
  });

  test('creates a new file only on execution and supports empty content', async () => {
    const prepared = await prepare('write_file', { path: 'new.txt', content: '' });
    expect(prepared.preview.title).toBe('Create file');
    await expect(stat(path.join(workspace, 'new.txt'))).rejects.toThrow();
    await prepared.execute(signal());
    expect(await readFile(path.join(workspace, 'new.txt'), 'utf8')).toBe('');
    expect((await stat(path.join(workspace, 'new.txt'))).mode & 0o777).toBe(0o600);
  });

  test('refuses stale content, replacement inode and a newly created target', async () => {
    const content = await prepare('write_file', { path: 'hello.txt', content: 'proposed' });
    await writeFile(path.join(workspace, 'hello.txt'), 'changed externally');
    await expect(content.execute(signal())).rejects.toThrow('stale');
    expect(await readFile(path.join(workspace, 'hello.txt'), 'utf8')).toBe('changed externally');
    const inode = await prepare('write_file', { path: 'hello.txt', content: 'proposed' });
    await rename(path.join(workspace, 'hello.txt'), path.join(workspace, 'old.txt'));
    await writeFile(path.join(workspace, 'hello.txt'), 'replacement');
    await expect(inode.execute(signal())).rejects.toThrow('changed');
    expect(await readFile(path.join(workspace, 'hello.txt'), 'utf8')).toBe('replacement');
    const newFile = await prepare('write_file', { path: 'new.txt', content: 'proposed' });
    await writeFile(path.join(workspace, 'new.txt'), 'created externally');
    await expect(newFile.execute(signal())).rejects.toThrow('stale');
    expect(await readFile(path.join(workspace, 'new.txt'), 'utf8')).toBe('created externally');
  });

  test('refuses symlink leaf and parent substitutions between preview and execution', async () => {
    const leaf = await prepare('write_file', { path: 'hello.txt', content: 'bad' });
    await rm(path.join(workspace, 'hello.txt'));
    await symlink(path.join(external, 'secret.txt'), path.join(workspace, 'hello.txt'));
    await expect(leaf.execute(signal())).rejects.toThrow('changed');
    await mkdir(path.join(workspace, 'nested'));
    const parent = await prepare('write_file', { path: 'nested/new.txt', content: 'bad' });
    await rename(path.join(workspace, 'nested'), path.join(workspace, 'saved'));
    await symlink(external, path.join(workspace, 'nested'));
    await expect(parent.execute(signal())).rejects.toThrow('changed');
    expect(await readFile(path.join(external, 'secret.txt'), 'utf8')).toBe('external secret');
    await expect(stat(path.join(external, 'new.txt'))).rejects.toThrow();
  });

  test('rejects a replaced regular parent directory and oversized diff previews', async () => {
    await mkdir(path.join(workspace, 'nested'));
    const prepared = await prepare('write_file', { path: 'nested/new.txt', content: 'proposed' });
    await rename(path.join(workspace, 'nested'), path.join(workspace, 'old-nested'));
    await mkdir(path.join(workspace, 'nested'));
    await expect(prepared.execute(signal())).rejects.toThrow('changed');
    await expect(stat(path.join(workspace, 'nested', 'new.txt'))).rejects.toThrow();
    await expect(
      prepare('write_file', { path: 'large.txt', content: '中'.repeat(40_000) }),
    ).rejects.toThrow('Diff preview exceeds');
    await expect(stat(path.join(workspace, 'large.txt'))).rejects.toThrow();
  });

  test('honors cancellation before preparation and before execution without creating files', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.prepare(call('write_file', { path: 'never.txt', content: 'x' }), controller.signal),
    ).rejects.toThrow();
    const prepared = await prepare('write_file', { path: 'never.txt', content: 'x' });
    await expect(prepared.execute(controller.signal)).rejects.toThrow();
    await expect(stat(path.join(workspace, 'never.txt'))).rejects.toThrow();
    await expect(
      run('write_file', { path: 'hello.txt', content: '中'.repeat(100_000) }),
    ).rejects.toThrow();
  });
});

async function waitForPid(name: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const value = Number((await readFile(path.join(workspace, name), 'utf8')).trim());
      if (value > 0) return value;
    } catch {
      /* Wait for the child to start. */
    }
    await pause(10);
  }
  throw new Error('Timed out waiting for test child PID.');
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  const status = Bun.spawnSync(['/bin/ps', '-p', String(pid), '-o', 'stat='])
    .stdout.toString()
    .trim();
  return Boolean(status) && !status.startsWith('Z');
}

describe('shell execution and cleanup', () => {
  test('reports a spawn failure without hanging or leaving listeners', async () => {
    await expect(
      runShell('pwd', path.join(fixture, 'missing-directory'), 100, signal()),
    ).rejects.toThrow('Failed to start shell');
  });

  test('previews real cwd, returns separate stdout/stderr and exit code', async () => {
    const prepared = await prepare('shell', {
      command: 'pwd; printf hello; printf problem >&2; exit 7',
    });
    expect(prepared.preview.cwd).toBe(workspace);
    expect(prepared.preview.command).toContain('exit 7');
    const result = await prepared.execute(signal());
    expect(result.content).toContain(workspace);
    expect(result.content).toContain('hello');
    expect(result.content).toContain('stderr:\nproblem');
    expect(result.exitCode).toBe(7);
    expect(result.isError).toBe(true);
  });

  test('does not inherit provider credentials or shell startup environment', async () => {
    const injected = {
      PROSPERO_TEST_PROVIDER_SECRET: 'must-not-leak',
      NODE_OPTIONS: '--require=forged-startup-module',
      BASH_ENV: '/forged-startup-script',
      ENV: '/forged-startup-script',
      LD_PRELOAD: '/forged-loader-library',
      DYLD_INSERT_LIBRARIES: '/forged-loader-library',
      PATH: workspace,
    };
    const previous = new Map(Object.keys(injected).map((key) => [key, process.env[key]]));
    Object.assign(process.env, injected);
    try {
      const result = await run('shell', { command: 'env' });
      expect(result.content).not.toContain('must-not-leak');
      expect(result.content).not.toContain('OPENAI_API_KEY=');
      for (const key of Object.keys(injected).filter((key) => key !== 'PATH'))
        expect(result.content).not.toContain(`${key}=`);
      expect(result.content).toContain(`HOME=${homedir()}`);
      expect(result.content).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:');
      expect(result.content).not.toContain(`PATH=${workspace}`);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test.skipIf(!supportedRuntimePaths.includes(path.dirname(process.execPath)))(
    'resolves the current runtime from controlled paths with explicit HOME and workspace cwd',
    async () => {
      const runtime = path.basename(process.execPath);
      if (!['bun', 'node'].includes(runtime)) throw new Error('Unexpected test runtime.');
      const result = await run('shell', {
        command: `${runtime} -e 'console.log("runtime-resolved"); console.log(process.env.HOME); console.log(process.cwd())'`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.content).toContain('runtime-resolved');
      expect(result.content).toContain(homedir());
      expect(result.content).toContain(workspace);
    },
  );

  test.skipIf(!hasSupportedRuntime('bun'))(
    'runs real bun test in an attached workspace',
    async () => {
      await writeFile(
        path.join(workspace, 'fixture.test.ts'),
        'import { expect, test } from "bun:test"; test("workspace tool fixture", () => expect(2 + 2).toBe(4));\n',
      );
      const result = await run('shell', { command: 'bun test' });
      expect(result.exitCode).toBe(0);
      expect(result.content).toContain('workspace tool fixture');
      expect(result.content).toContain('1 pass');
    },
  );

  test.skipIf(!hasSupportedRuntime('npm') || !hasSupportedRuntime('node'))(
    'runs real npm test with node resolved from controlled paths',
    async () => {
      await writeFile(
        path.join(workspace, 'package.json'),
        JSON.stringify({
          name: 'prospero-shell-fixture',
          private: true,
          scripts: { test: 'node verify.cjs' },
        }),
      );
      await writeFile(
        path.join(workspace, 'verify.cjs'),
        'if (!process.env.HOME) throw new Error("HOME missing"); console.log("npm-test-real-ok");\n',
      );
      const result = await run('shell', { command: 'npm test' });
      expect(result.exitCode).toBe(0);
      expect(result.content).toContain('npm-test-real-ok');
    },
  );

  test('keeps bounded output head and tail on both streams', async () => {
    const result = await run('shell', {
      command:
        'printf HEAD; yes x | head -c 100000; printf TAIL; printf ERRHEAD >&2; yes y | head -c 100000 >&2; printf ERRTAIL >&2',
    });
    expect(result.content).toContain('HEAD');
    expect(result.content).toContain('TAIL');
    expect(result.content).toContain('ERRHEAD');
    expect(result.content).toContain('ERRTAIL');
    expect(result.content).toContain('Exit code: 0');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(TOOL_LIMITS.outputBytes);
  });

  test('times out and awaits termination of a stubborn child and grandchild', async () => {
    const prepared = await prepare('shell', {
      command:
        '/bin/sh -c \'trap "" TERM; sleep 30 & echo $! > grandchild.pid; wait\' & echo $! > child.pid; wait',
      timeoutMs: 300,
    });
    const pending = prepared.execute(signal());
    const child = await waitForPid('child.pid');
    const grandchild = await waitForPid('grandchild.pid');
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Timed out');
    expect(processRunning(child)).toBe(false);
    expect(processRunning(grandchild)).toBe(false);
  });

  test('cancellation waits for process-group cleanup before rejecting', async () => {
    const controller = new AbortController();
    const prepared = await prepare('shell', {
      command:
        '/bin/sh -c \'trap "" TERM; sleep 30 & echo $! > grandchild.pid; wait\' & echo $! > child.pid; wait',
    });
    const pending = prepared.execute(controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    const child = await waitForPid('child.pid');
    const grandchild = await waitForPid('grandchild.pid');
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(processRunning(child)).toBe(false);
    expect(processRunning(grandchild)).toBe(false);
  });

  test('cleans background children even after successful shell exit and propagates errors', async () => {
    const result = await run('shell', { command: 'sleep 30 & echo $! > background.pid; exit 0' });
    const child = await waitForPid('background.pid');
    expect(result.exitCode).toBe(0);
    expect(processRunning(child)).toBe(false);
    expect((await run('shell', { command: 'prospero_nonexistent_test_command' })).isError).toBe(
      true,
    );
    const controller = new AbortController();
    controller.abort();
    const prepared = await prepare('shell', { command: 'touch never.txt' });
    await expect(prepared.execute(controller.signal)).rejects.toThrow();
    await expect(stat(path.join(workspace, 'never.txt'))).rejects.toThrow();
  });
});

test('UTF-8 output truncation maintains a byte ceiling', () => {
  for (const bytes of [32, 33, 127, 1_024])
    expect(Buffer.byteLength(boundOutput('中'.repeat(2_000), bytes).content)).toBeLessThanOrEqual(
      bytes,
    );
});
