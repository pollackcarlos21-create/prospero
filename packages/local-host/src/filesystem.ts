import { constants } from 'node:fs';
import { lstat, open, opendir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TOOL_LIMITS } from '@prospero/tools';
import type { FileScope, ToolResult } from '@prospero/core';
import { boundOutput, throwIfAborted } from './limits';

export interface PathEntry {
  path: string;
  stat: Stats;
}
export interface FileSnapshot {
  path: string;
  chain: PathEntry[];
  stat?: Stats;
  bytes: Buffer;
  hash: string;
}
export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const sameIdentity = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const identityKey = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.mode}`;
export const sameFile = (a: Stats, b: Stats) =>
  sameIdentity(a, b) &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export const inside = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const fileInfo = (name: string, stat: Stats) => ({
  name,
  type: stat.isSymbolicLink()
    ? 'symlink'
    : stat.isDirectory()
      ? 'directory'
      : stat.isFile()
        ? 'file'
        : 'other',
  sizeBytes: stat.isFile() ? stat.size : null,
  modifiedAt: new Date(stat.mtimeMs).toISOString(),
  createdAt: stat.birthtimeMs > 0 ? new Date(stat.birthtimeMs).toISOString() : null,
});
const timeBasis = 'Filesystem timestamps, not download dates; metadata is observed per page.';
const pageCursor = (snapshot: string, after: string) =>
  Buffer.from(JSON.stringify({ snapshot, after })).toString('base64url');
function cursorAfter(cursor: string, snapshot: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).length !== 2 ||
      value.snapshot !== snapshot ||
      typeof value.after !== 'string' ||
      pageCursor(snapshot, value.after) !== cursor
    )
      throw new Error();
    return value.after;
  } catch {
    throw new Error('Directory cursor is invalid or stale. Restart listing without a cursor.');
  }
}
export function lastEntry(entries: PathEntry[]): PathEntry {
  const entry = entries.at(-1);
  if (!entry) throw new Error('Invalid empty filesystem path.');
  return entry;
}

export async function captureFileScope(
  requestedPath: string,
  mode: FileScope['mode'],
  kind?: FileScope['kind'],
): Promise<FileScope> {
  const absolute = path.resolve(requestedPath);
  const chain = await inspectChain(absolute);
  const stat = lastEntry(chain).stat;
  const actualKind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined;
  if (!actualKind || (kind && kind !== actualKind))
    throw new Error('Scope must be a regular file or directory.');
  if (actualKind === 'file' && mode !== 'read')
    throw new Error('File scopes grant exact-file reads only.');
  return Object.freeze({
    id: randomUUID(),
    path: absolute,
    label: path.basename(absolute) || absolute,
    mode,
    kind: actualKind,
    identity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
  });
}

/** Walk every component, including ancestors of the attached root; never follow symlinks. */
export async function inspectChain(target: string, allowMissingLeaf = false): Promise<PathEntry[]> {
  const parsed = path.parse(target);
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const entries: PathEntry[] = [{ path: current, stat: await lstat(current) }];
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && isMissing(error)) return entries;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${current}`);
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error(`Path component is not a directory: ${current}`);
    entries.push({ path: current, stat });
  }
  return entries;
}

export async function verifyChain(expected: PathEntry[]): Promise<void> {
  for (const entry of expected) {
    const current = await lstat(entry.path);
    if (current.isSymbolicLink() || !sameIdentity(entry.stat, current))
      throw new Error(`Path changed since preview: ${entry.path}`);
  }
}

export async function boundedRead(handle: FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position < limit) {
    const buffer = Buffer.alloc(Math.min(16_384, limit - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
}

async function boundedEntries(
  target: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ entries: Dirent[]; more: boolean }> {
  throwIfAborted(signal);
  const directory = await opendir(target);
  const entries: Dirent[] = [];
  try {
    for (;;) {
      throwIfAborted(signal);
      const entry = await directory.read();
      if (!entry) return { entries, more: false };
      if (entries.length >= limit) return { entries, more: true };
      entries.push(entry);
    }
  } finally {
    await directory.close();
  }
}

export class FilesystemBoundary {
  readonly workspace?: string;
  private readonly attachments: Set<string>;
  private readonly attachmentIdentities = new Map<string, Stats>();
  private workspaceIdentity?: Stats;
  private readonly workspaceScopeId?: string;
  private readonly attachmentScopeIds = new Map<string, string>();

  constructor(
    workspace?: string,
    attachments: string[] = [],
    private readonly scopes: FileScope[] = [],
  ) {
    this.workspace = workspace ? path.resolve(workspace) : undefined;
    this.attachments = new Set(attachments.map((entry) => path.resolve(entry)));
    this.workspaceScopeId = scopes.find(
      (scope) => scope.kind === 'directory' && scope.path === this.workspace,
    )?.id;
    for (const attachment of this.attachments) {
      const scope = scopes.find((entry) => entry.kind === 'file' && entry.path === attachment);
      if (scope) this.attachmentScopeIds.set(attachment, scope.id);
    }
  }

  async requireWorkspace(signal: AbortSignal, write = false): Promise<string> {
    throwIfAborted(signal);
    if (!this.workspace) throw new Error('Attach a workspace before using this tool.');
    if (this.workspaceScopeId) await this.scope(this.workspaceScopeId, signal, write);
    const chain = await inspectChain(this.workspace);
    const stat = lastEntry(chain).stat;
    if (!stat.isDirectory()) throw new Error('Attached workspace is not a directory.');
    if (this.workspaceIdentity && !sameIdentity(this.workspaceIdentity, stat))
      throw new Error('Attached workspace changed. Reattach it before continuing.');
    this.workspaceIdentity ??= stat;
    throwIfAborted(signal);
    return this.workspace;
  }

  async scope(scopeId: string, signal: AbortSignal, write = false): Promise<FileScope> {
    throwIfAborted(signal);
    const scope = this.scopes.find((entry) => entry.id === scopeId);
    if (!scope?.identity) throw new Error('File scope is unavailable or revoked.');
    if (write && (scope.mode !== 'write' || scope.kind !== 'directory'))
      throw new Error('File scope is read-only.');
    const stat = lastEntry(await inspectChain(scope.path)).stat;
    if (
      stat.dev !== scope.identity.dev ||
      stat.ino !== scope.identity.ino ||
      (scope.kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
    )
      throw new Error('File scope changed or was revoked. Select it again.');
    throwIfAborted(signal);
    return scope;
  }

  async resolve(
    input: string,
    signal: AbortSignal,
    allowAttachment = false,
    scopeId?: string,
    write = false,
  ): Promise<string> {
    throwIfAborted(signal);
    if (input.includes('\0') || input.split(path.sep).includes('..'))
      throw new Error('Parent traversal is not allowed.');
    if (scopeId) {
      const scope = await this.scope(scopeId, signal, write);
      const target =
        scope.kind === 'file' && input === '.' ? scope.path : path.resolve(scope.path, input);
      if (!inside(scope.path, target) || (scope.kind === 'file' && target !== scope.path))
        throw new Error('Path is outside the selected file scope.');
      return target;
    }
    if (allowAttachment && path.isAbsolute(input) && this.attachments.has(input)) {
      await this.requireAttachment(input, signal);
      return input;
    }
    const root = await this.requireWorkspace(signal, write);
    const target = path.resolve(root, input);
    if (!inside(root, target)) throw new Error('Path is outside the attached workspace.');
    return target;
  }

  private async requireAttachment(target: string, signal: AbortSignal): Promise<Stats> {
    throwIfAborted(signal);
    if (!this.attachments.has(target)) throw new Error('File is not an explicitly attached file.');
    const scopeId = this.attachmentScopeIds.get(target);
    if (scopeId) await this.scope(scopeId, signal);
    const current = lastEntry(await inspectChain(target)).stat;
    if (!current.isFile()) throw new Error('Only regular files can be attached.');
    const expected = this.attachmentIdentities.get(target);
    if (expected && !sameIdentity(expected, current))
      throw new Error('Attached file changed. Reattach it before continuing.');
    this.attachmentIdentities.set(target, current);
    throwIfAborted(signal);
    return current;
  }

  async permissionKey(target: string, signal: AbortSignal, scopeId?: string): Promise<string> {
    if (scopeId) {
      const scope = await this.scope(scopeId, signal);
      return `read:scope:${scope.id}:${scope.path}:${scope.identity?.dev}:${scope.identity?.ino}`;
    }
    if (this.workspace && inside(this.workspace, target)) {
      const root = await this.requireWorkspace(signal);
      if (!this.workspaceIdentity) throw new Error('Workspace identity is unavailable.');
      return `read:workspace:${root}:${identityKey(this.workspaceIdentity)}`;
    }
    const attachment = await this.requireAttachment(target, signal);
    return `read:attachment:${target}:${identityKey(attachment)}`;
  }

  private async authorizeRead(
    target: string,
    signal: AbortSignal,
    scopeId?: string,
  ): Promise<void> {
    if (scopeId) {
      const scope = await this.scope(scopeId, signal);
      if (!inside(scope.path, target) || (scope.kind === 'file' && target !== scope.path))
        throw new Error('Path is outside the selected file scope.');
      return;
    }
    if (this.workspace && inside(this.workspace, target)) await this.requireWorkspace(signal);
    else await this.requireAttachment(target, signal);
  }

  async read(
    target: string,
    signal: AbortSignal,
    limit = TOOL_LIMITS.fileBytes,
    scopeId?: string,
  ): Promise<{ bytes: Buffer; truncated: boolean }> {
    throwIfAborted(signal);
    await this.authorizeRead(target, signal, scopeId);
    const chain = await inspectChain(target);
    const expected = lastEntry(chain).stat;
    const attachment = this.attachmentIdentities.get(target);
    if (attachment && !sameIdentity(attachment, expected))
      throw new Error('Attached file changed. Reattach it before continuing.');
    if (!expected.isFile()) throw new Error('Only regular files can be read.');
    if (expected.size > TOOL_LIMITS.fileBytes)
      throw new Error(`File exceeds ${TOOL_LIMITS.fileBytes} bytes.`);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !sameFile(expected, stat))
        throw new Error('File changed while opening.');
      await verifyChain(chain);
      throwIfAborted(signal);
      const bytes = await boundedRead(handle, Math.min(limit + 1, TOOL_LIMITS.fileBytes + 1));
      throwIfAborted(signal);
      if (!sameFile(stat, await handle.stat()))
        throw new Error('File changed while reading. Retry the read.');
      await this.authorizeRead(target, signal, scopeId);
      if (bytes.includes(0)) throw new Error('Binary files are not supported by read_file.');
      return { bytes: bytes.subarray(0, limit), truncated: bytes.length > limit };
    } finally {
      await handle.close();
    }
  }

  async info(target: string, signal: AbortSignal, scopeId?: string): Promise<ToolResult> {
    throwIfAborted(signal);
    await this.authorizeRead(target, signal, scopeId);
    const chain = await inspectChain(target);
    const expected = lastEntry(chain).stat;
    if (!expected.isFile() && !expected.isDirectory())
      throw new Error('Only regular files and directories can be inspected.');
    await verifyChain(chain);
    if (!sameFile(expected, await lstat(target)))
      throw new Error('File changed while inspecting metadata. Retry the inspection.');
    await this.authorizeRead(target, signal, scopeId);
    throwIfAborted(signal);
    return { content: JSON.stringify({ ...fileInfo(path.basename(target), expected), timeBasis }) };
  }

  async list(
    target: string,
    signal: AbortSignal,
    maxEntries: number,
    scopeId?: string,
    cursor?: string,
  ): Promise<ToolResult> {
    throwIfAborted(signal);
    await this.authorizeRead(target, signal, scopeId);
    const chain = await inspectChain(target);
    const expected = lastEntry(chain).stat;
    if (!expected.isDirectory()) throw new Error('Path is not a directory.');
    // A bounded scan permits deterministic pages independent of filesystem enumeration order.
    const { entries, more } = await boundedEntries(target, TOOL_LIMITS.maxDirectoryEntries, signal);
    if (more)
      throw new Error(
        `Directory exceeds ${TOOL_LIMITS.maxDirectoryEntries} entries. Narrow the directory.`,
      );
    await verifyChain(chain);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const snapshot = hash(
      Buffer.from(
        JSON.stringify({
          target,
          scopeId: scopeId ?? null,
          dev: expected.dev,
          ino: expected.ino,
          mtimeMs: expected.mtimeMs,
          ctimeMs: expected.ctimeMs,
          names: entries.map((entry) => entry.name),
        }),
      ),
    );
    const after = cursor ? cursorAfter(cursor, snapshot) : undefined;
    const previous = after === undefined ? -1 : entries.findIndex((entry) => entry.name === after);
    if (after !== undefined && previous < 0)
      throw new Error('Directory cursor is invalid or stale. Restart listing without a cursor.');
    const page: ReturnType<typeof fileInfo>[] = [];
    let index = previous + 1;
    const serialize = (nextCursor: string | null) =>
      JSON.stringify({
        entries: page,
        nextCursor,
        hasMore: nextCursor !== null,
        timeBasis,
      });
    for (; index < entries.length && page.length < maxEntries; index++) {
      throwIfAborted(signal);
      const entry = entries[index];
      // lstat labels a symlink itself; no target content or target metadata is read.
      page.push(fileInfo(entry.name, await lstat(path.join(target, entry.name))));
      const next = index + 1 < entries.length ? pageCursor(snapshot, entry.name) : null;
      if (Buffer.byteLength(serialize(next)) > TOOL_LIMITS.outputBytes) {
        page.pop();
        if (!page.length) throw new Error('Directory entry exceeds the output limit.');
        break;
      }
    }
    await verifyChain(chain);
    if (!sameFile(expected, await lstat(target)))
      throw new Error('Directory changed while listing. Restart listing without a cursor.');
    await this.authorizeRead(target, signal, scopeId);
    throwIfAborted(signal);
    const last = page.at(-1);
    const nextCursor = index < entries.length && last ? pageCursor(snapshot, last.name) : null;
    return { content: serialize(nextCursor), truncated: nextCursor !== null };
  }

  async search(
    target: string,
    pattern: string,
    signal: AbortSignal,
    maxResults: number,
    scopeId?: string,
  ): Promise<ToolResult> {
    throwIfAborted(signal);
    const chain = await inspectChain(target);
    if (!lastEntry(chain).stat.isDirectory()) throw new Error('Search path is not a directory.');
    const root = scopeId
      ? (await this.scope(scopeId, signal)).path
      : await this.requireWorkspace(signal);
    const results: string[] = [];
    let visited = 0;
    let truncated = false;
    let resultBytes = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      throwIfAborted(signal);
      if (depth > TOOL_LIMITS.maxSearchDepth) {
        truncated = true;
        return;
      }
      const directoryChain = await inspectChain(directory);
      const { entries, more } = await boundedEntries(
        directory,
        Math.max(0, TOOL_LIMITS.maxSearchFiles - visited),
        signal,
      );
      if (more) truncated = true;
      await verifyChain(directoryChain);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        throwIfAborted(signal);
        if (
          ++visited > TOOL_LIMITS.maxSearchFiles ||
          results.length >= maxResults ||
          resultBytes >= TOOL_LIMITS.outputBytes - 512
        ) {
          truncated = true;
          return;
        }
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(child, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        let bytes: Buffer;
        try {
          bytes = (await this.read(child, signal, TOOL_LIMITS.fileBytes, scopeId)).bytes;
        } catch (error) {
          throwIfAborted(signal);
          // Unsafe races fail the whole request. Only explicitly unsupported content is skipped.
          if (
            error instanceof Error &&
            (error.message.startsWith('File exceeds ') || error.message.startsWith('Binary files '))
          )
            continue;
          throw error;
        }
        const lines = bytes.toString('utf8').split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].includes(pattern)) continue;
          const location = path.relative(root, child);
          const line = `${JSON.stringify(location)}:${index + 1}: ${boundOutput(lines[index], 512).content}`;
          results.push(line);
          resultBytes += Buffer.byteLength(line) + 1;
          if (results.length >= maxResults || resultBytes >= TOOL_LIMITS.outputBytes - 512) {
            truncated = true;
            break;
          }
        }
      }
    };
    await walk(target, 0);
    await verifyChain(chain);
    await this.authorizeRead(target, signal, scopeId);
    if (truncated) results.push('… search limits reached; narrow the directory or pattern …');
    const bounded = boundOutput(results.join('\n') || '(no matches)');
    return { ...bounded, truncated: truncated || bounded.truncated };
  }

  async snapshotWrite(
    target: string,
    signal: AbortSignal,
    scopeId?: string,
  ): Promise<FileSnapshot> {
    throwIfAborted(signal);
    const chain = await inspectChain(target, true);
    const leaf = lastEntry(chain);
    const exists = leaf.path === target;
    if (exists && !leaf.stat.isFile()) throw new Error('Only regular files can be written.');
    if (exists && leaf.stat.nlink > 1)
      throw new Error('Hard-linked files cannot be safely replaced.');
    let bytes: Buffer = Buffer.alloc(0);
    if (exists) bytes = (await this.read(target, signal, TOOL_LIMITS.fileBytes, scopeId)).bytes;
    await verifyChain(chain);
    throwIfAborted(signal);
    return { path: target, chain, stat: exists ? leaf.stat : undefined, bytes, hash: hash(bytes) };
  }

  async write(
    snapshot: FileSnapshot,
    content: string,
    signal: AbortSignal,
    scopeId?: string,
  ): Promise<ToolResult> {
    throwIfAborted(signal);
    if (scopeId) await this.scope(scopeId, signal, true);
    else await this.requireWorkspace(signal, true);
    await verifyChain(snapshot.chain);
    const bytes = Buffer.from(content);
    if (bytes.length > TOOL_LIMITS.fileBytes)
      throw new Error('File content exceeds the size limit.');
    let handle: FileHandle;
    try {
      handle = await open(
        snapshot.path,
        snapshot.stat
          ? constants.O_RDWR | constants.O_NOFOLLOW
          : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'EEXIST' ||
        isMissing(error) ||
        (error as NodeJS.ErrnoException).code === 'ELOOP'
      )
        throw new Error('Write preview is stale; request a new preview.');
      throw error;
    }
    let wrote = false;
    let opened: Stats | undefined;
    try {
      opened = await handle.stat();
      if (!opened.isFile()) throw new Error('Write target is not a regular file.');
      if (opened.nlink > 1) throw new Error('Hard-linked files cannot be safely replaced.');
      if (snapshot.stat) {
        if (!sameFile(snapshot.stat, opened))
          throw new Error('Write preview is stale; request a new preview.');
        const current = await boundedRead(handle, TOOL_LIMITS.fileBytes + 1);
        if (hash(current) !== snapshot.hash)
          throw new Error('Write preview is stale; request a new preview.');
      }
      await verifyChain(snapshot.chain);
      const leaf = await lstat(snapshot.path);
      if (leaf.isSymbolicLink() || !sameIdentity(opened, leaf))
        throw new Error('Write path changed since preview.');
      const latest = await handle.stat();
      if (latest.nlink > 1) throw new Error('Hard-linked files cannot be safely replaced.');
      if (!sameFile(opened, latest))
        throw new Error('Write preview is stale; request a new preview.');
      throwIfAborted(signal);
      // The validated descriptor pins the file even if another process renames a path.
      // Avoid truncating a replacement target via a second pathname open.
      await handle.writeFile(bytes);
      await handle.truncate(bytes.length);
      await handle.sync();
      wrote = true;
      return { content: `Wrote ${bytes.length} bytes to ${snapshot.path}.` };
    } finally {
      await handle.close();
      if (!snapshot.stat && !wrote && opened) {
        try {
          if (sameIdentity(opened, await lstat(snapshot.path))) await unlink(snapshot.path);
        } catch {
          /* Never remove an unrelated replacement file. */
        }
      }
    }
  }
}
