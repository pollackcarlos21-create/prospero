import type {
  ActionJournalPort,
  FileScope,
  NativeActionAdapter,
  PreparedTool,
  StructuredAction,
  ToolCall,
  ToolHost,
  ToolResult,
} from '@prospero/core';
import { TOOL_DEFINITIONS, TOOL_LIMITS, validateToolArguments } from '@prospero/tools';
import { FilesystemBoundary } from './filesystem';
import { boundOutput, throwIfAborted } from './limits';
import { runShell } from './shell';
import { previewDiff } from './preview';
import { prepareActionPlan, type MutationLedger } from './action-plan';

export interface LocalToolHostOptions {
  workspace?: string;
  attachments?: string[];
  askBeforeReads?: boolean;
  scopes?: FileScope[];
  journal?: ActionJournalPort;
  native?: NativeActionAdapter;
}

export function createLocalToolHost(options: LocalToolHostOptions = {}): ToolHost {
  const filesystem = new FilesystemBoundary(options.workspace, options.attachments, options.scopes);
  const ledger: MutationLedger = { denied: false };
  const definitions = TOOL_DEFINITIONS.filter(
    (item) =>
      !['authorize_research', 'web_search', 'fetch_source', 'fetch_page'].includes(item.name),
  );
  return {
    definitions: structuredClone(definitions),
    async prepare(call: ToolCall, signal: AbortSignal): Promise<PreparedTool> {
      throwIfAborted(signal);
      const args = validateToolArguments(call.name, call.arguments);
      const definition = definitions.find((item) => item.name === call.name);
      if (!definition) throw new Error(`Unknown tool: ${call.name}`);
      if (definition.riskLevel !== 'read' && ledger.denied)
        throw new Error(
          'A mutation was denied in this run. Start a new task to request new approval.',
        );
      if (call.name === 'execute_plan')
        return prepareActionPlan({
          call,
          definition,
          title: args.title as string,
          actions: args.actions as StructuredAction[],
          filesystem,
          journal: options.journal,
          native: options.native,
          ledger,
          signal,
        });
      const scopeId = args.scopeId as string | undefined;
      const base = {
        call,
        definition,
        allowSession: definition.riskLevel === 'read',
        onDecision(decision: import('@prospero/core').PermissionDecision) {
          if (decision === 'deny' && definition.riskLevel !== 'read') ledger.denied = true;
        },
        requiresPermission: definition.riskLevel !== 'read' || (options.askBeforeReads ?? false),
      };
      if (call.name === 'shell') {
        const cwd = await filesystem.requireWorkspace(signal, true);
        const command = args.command as string;
        return {
          ...base,
          permissionKey: `shell:${cwd}`,
          preview: { kind: 'shell', title: 'Run shell command (full user access)', cwd, command },
          async execute(executionSignal) {
            throwIfAborted(executionSignal);
            if (ledger.denied) throw new Error('A mutation was denied in this run.');
            await filesystem.requireWorkspace(executionSignal, true);
            return runShell(
              command,
              cwd,
              (args.timeoutMs as number | undefined) ?? TOOL_LIMITS.defaultTimeoutMs,
              executionSignal,
            );
          },
        };
      }
      const requested = (args.path as string | undefined) ?? '.';
      const exactFileRead = call.name === 'read_file' || call.name === 'get_file_info';
      const target = await filesystem.resolve(
        requested,
        signal,
        exactFileRead,
        scopeId,
        call.name === 'write_file',
      );
      if (call.name === 'write_file') {
        const snapshot = await filesystem.snapshotWrite(target, signal, scopeId);
        const content = args.content as string;
        const before = snapshot.bytes.toString('utf8');
        const patch = await previewDiff(target, before, content, Boolean(snapshot.stat), signal);
        if (Buffer.byteLength(patch) > TOOL_LIMITS.outputBytes)
          throw new Error('Diff preview exceeds the size limit. Use a smaller change.');
        return {
          ...base,
          permissionKey: `write:${target}`,
          // The complete diff is authoritative for approval; oversized patches are rejected.
          preview: {
            kind: 'write',
            title: snapshot.stat ? 'Replace file' : 'Create file',
            path: target,
            before: boundOutput(before).content,
            after: boundOutput(content).content,
            diff: patch,
          },
          async execute(executionSignal) {
            if (ledger.denied) throw new Error('A mutation was denied in this run.');
            return filesystem.write(snapshot, content, executionSignal, scopeId);
          },
        };
      }
      return {
        ...base,
        permissionKey: await filesystem.permissionKey(target, signal, scopeId),
        preview: {
          kind: 'read',
          title:
            call.name === 'read_file'
              ? 'Read file'
              : call.name === 'get_file_info'
                ? 'Inspect file information'
                : call.name === 'list_directory'
                  ? 'List directory'
                  : `Search for ${JSON.stringify(args.pattern)}`,
          path: target,
        },
        async execute(executionSignal): Promise<ToolResult> {
          throwIfAborted(executionSignal);
          // Re-resolve on execution so revoked/replaced workspace paths cannot escape through a prepared read.
          await filesystem.resolve(requested, executionSignal, exactFileRead, scopeId);
          if (
            scopeId &&
            !exactFileRead &&
            (await filesystem.scope(scopeId, executionSignal)).kind === 'file'
          )
            throw new Error('File scopes grant exact-file reads only.');
          if (call.name === 'get_file_info')
            return filesystem.info(target, executionSignal, scopeId);
          if (call.name === 'read_file') {
            const result = await filesystem.read(
              target,
              executionSignal,
              (args.maxBytes as number | undefined) ?? TOOL_LIMITS.fileBytes,
              scopeId,
            );
            const bounded = boundOutput(result.bytes.toString('utf8'));
            return { ...bounded, truncated: result.truncated || bounded.truncated };
          }
          if (call.name === 'list_directory')
            return filesystem.list(
              target,
              executionSignal,
              (args.maxEntries as number | undefined) ?? TOOL_LIMITS.maxEntries,
              scopeId,
              args.cursor as string | undefined,
            );
          return filesystem.search(
            target,
            args.pattern as string,
            executionSignal,
            (args.maxResults as number | undefined) ?? TOOL_LIMITS.maxSearchResults,
            scopeId,
          );
        },
      };
    },
  };
}

export { TOOL_LIMITS } from '@prospero/tools';
export { captureFileScope } from './filesystem';
export { ACTION_FILE_BYTES, ActionFailure } from './action-plan';
