import { Channels } from '../ipc';
import type { DesktopService } from './service';
import {
  clipboardText,
  contextMenuTarget,
  decision,
  id,
  providerInput,
  settingsInput,
  text,
  UserError,
  scopeMode,
  planDigest,
  researchDigest,
  webSearchInput,
  webSearchTestInput,
} from './validation';
export interface InvokeContext {
  senderId: number;
  frameUrl: string;
  isMainFrame: boolean;
}
export interface IpcRegistrar {
  handle(channel: string, handler: (context: InvokeContext, ...args: unknown[]) => unknown): void;
}
export function registerDesktopIpc(
  registrar: IpcRegistrar,
  service: DesktopService,
  trusted: () => { senderId: number; url: string } | undefined,
  rejected: () => void,
) {
  const handlers: Record<string, { count: number; run: (...args: unknown[]) => unknown }> = {
    [Channels.bootstrap]: { count: 0, run: () => service.bootstrap() },
    [Channels.ready]: { count: 0, run: () => service.desktopReady() },
    [Channels.createConversation]: { count: 0, run: () => service.createConversation() },
    [Channels.getConversation]: { count: 1, run: (c) => service.getConversation(id(c)) },
    [Channels.deleteConversation]: { count: 1, run: (c) => service.deleteConversation(id(c)) },
    [Channels.renameConversation]: {
      count: 2,
      run: (c, t) => service.renameConversation(id(c), text(t, 120)),
    },
    [Channels.showContextMenu]: {
      count: 1,
      run: (target) => service.showContextMenu(contextMenuTarget(target)),
    },
    [Channels.copyText]: { count: 1, run: (value) => service.copyText(clipboardText(value)) },
    [Channels.selectProvider]: { count: 2, run: (c, p) => service.selectProvider(id(c), id(p)) },
    [Channels.chooseWorkspace]: { count: 1, run: (c) => service.chooseWorkspace(id(c)) },
    [Channels.attachFiles]: { count: 1, run: (c) => service.attachFiles(id(c)) },
    [Channels.addScope]: { count: 2, run: (c, mode) => service.addScope(id(c), scopeMode(mode)) },
    [Channels.removeScope]: { count: 2, run: (c, scope) => service.removeScope(id(c), id(scope)) },
    [Channels.saveWebSearch]: {
      count: 1,
      run: (input) => service.saveWebSearch(webSearchInput(input)),
    },
    [Channels.testWebSearch]: {
      count: 1,
      run: (input) => service.testWebSearch(webSearchTestInput(input)),
    },
    [Channels.openSource]: { count: 2, run: (c, source) => service.openSource(id(c), id(source)) },
    [Channels.decideActionPlan]: {
      count: 4,
      run: (c, r, digest, d) => {
        const permission = decision(d);
        if (permission === 'allow-session')
          throw new UserError('Action Plans require one-time approval.');
        return service.decideActionPlan(id(c), text(r, 300), planDigest(digest), permission);
      },
    },
    [Channels.decideResearch]: {
      count: 4,
      run: (c, r, digest, d) => {
        const permission = decision(d);
        if (permission === 'allow-session')
          throw new UserError('Research requires one-time approval.');
        return service.decideResearch(id(c), text(r, 300), researchDigest(digest), permission);
      },
    },
    [Channels.sendTask]: { count: 2, run: (c, t) => service.sendTask(id(c), text(t)) },
    [Channels.stopTask]: { count: 1, run: (c) => service.stopTask(id(c)) },
    [Channels.decidePermission]: {
      count: 3,
      run: (c, r, d) => service.decidePermission(id(c), text(r, 300), decision(d)),
    },
    [Channels.saveProvider]: { count: 1, run: (p) => service.saveProvider(providerInput(p)) },
    [Channels.deleteProvider]: { count: 1, run: (p) => service.deleteProvider(id(p)) },
    [Channels.testProvider]: { count: 1, run: (p) => service.testProvider(providerInput(p)) },
    [Channels.saveSettings]: { count: 1, run: (s) => service.saveSettings(settingsInput(s)) },
  };
  for (const [channel, handler] of Object.entries(handlers))
    registrar.handle(channel, async (context, ...args) => {
      const allowed = trusted();
      if (
        !allowed ||
        context.senderId !== allowed.senderId ||
        context.frameUrl !== allowed.url ||
        !context.isMainFrame ||
        args.length !== handler.count
      ) {
        rejected();
        throw new Error('Request rejected by the desktop security boundary.');
      }
      try {
        return await handler.run(...args);
      } catch (error) {
        throw new Error(
          error instanceof UserError
            ? error.message
            : 'Unable to complete this action. Check the settings and try again.',
        );
      }
    });
}
