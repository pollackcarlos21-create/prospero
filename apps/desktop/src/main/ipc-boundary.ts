import { Channels } from '../ipc';
import type { DesktopService } from './service';
import type { DotApplication } from './dot-application';
import { DotError, rehydrateDotRecordQuery } from '@prospero/dots';
import { DotRepositoryError } from '@prospero/persistence';
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
  dotId,
  dotRevision,
  dotControl,
  dotInput,
  dotPage,
  dotPolicyTerms,
  dotReviewInput,
  dotContextQuery,
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
  dots?: DotApplication,
) {
  const requireDots = () => {
    if (!dots) throw new UserError('Dots are not available in this window.');
    return dots;
  };
  const handlers: Record<string, { count: number; run: (...args: unknown[]) => unknown }> = {
    [Channels.dotsRecord]: {
      count: 2,
      run: (value, query) => requireDots().record(dotId(value), rehydrateDotRecordQuery(query)),
    },
    [Channels.dotsContext]: {
      count: 2,
      run: (value, query) => requireDots().context(dotId(value), dotContextQuery(query)),
    },
    [Channels.dotsSupervision]: { count: 0, run: () => requireDots().supervision() },
    [Channels.dotsRequests]: {
      count: 2,
      run: (value, options) => requireDots().requests(dotId(value), dotPage(options)),
    },
    [Channels.dotsReviewUnknown]: {
      count: 6,
      run: (value, revision, intent, intentRevision, digest, input) =>
        requireDots().reviewUnknown(
          dotId(value),
          dotRevision(revision),
          dotId(intent),
          dotRevision(intentRevision),
          planDigest(digest),
          dotReviewInput(input),
        ),
    },
    [Channels.dotsScheduleWake]: {
      count: 4,
      run: (value, revision, policy, dueAt) =>
        requireDots().scheduleWake(
          dotId(value),
          dotRevision(revision),
          dotId(policy),
          dotRevision(dueAt),
        ),
    },
    [Channels.dotsCancelWake]: {
      count: 3,
      run: (value, wake, revision) =>
        requireDots().cancelWake(dotId(value), dotId(wake), dotRevision(revision)),
    },
    [Channels.dotsList]: { count: 1, run: (options) => requireDots().list(dotPage(options, true)) },
    [Channels.dotsGet]: { count: 1, run: (value) => requireDots().get(dotId(value)) },
    [Channels.dotsCreate]: { count: 1, run: (input) => requireDots().create(dotInput(input)) },
    [Channels.dotsRun]: {
      count: 3,
      run: (value, revision, provider) =>
        requireDots().run(dotId(value), dotRevision(revision), id(provider)),
    },
    [Channels.dotsStop]: { count: 1, run: (value) => requireDots().stop(dotId(value)) },
    [Channels.dotsTransition]: {
      count: 3,
      run: (value, revision, command) =>
        requireDots().transition(dotId(value), dotRevision(revision), dotControl(command)),
    },
    [Channels.dotsHistory]: {
      count: 2,
      run: (value, options) => requireDots().history(dotId(value), dotPage(options)),
    },
    [Channels.dotsCheckpoints]: {
      count: 2,
      run: (value, options) => requireDots().checkpoints(dotId(value), dotPage(options)),
    },
    [Channels.dotsDecide]: {
      count: 6,
      run: (value, revision, intent, intentRevision, digest, decision) => {
        if (decision !== 'approve' && decision !== 'deny')
          throw new UserError('Invalid Dot approval decision.');
        return requireDots().decide(
          dotId(value),
          dotRevision(revision),
          dotId(intent),
          dotRevision(intentRevision),
          planDigest(digest),
          decision,
        );
      },
    },
    [Channels.dotsResumeApproval]: {
      count: 3,
      run: (value, revision, intent) =>
        requireDots().resumeApproval(dotId(value), dotRevision(revision), dotId(intent)),
    },
    [Channels.dotsOpenSource]: {
      count: 3,
      run: (value, intent, source) =>
        requireDots().openSource(dotId(value), dotId(intent), id(source)),
    },
    [Channels.dotsAuthorizeResearch]: {
      count: 4,
      run: (value, revision, provider, input) =>
        requireDots().authorizeResearch(
          dotId(value),
          dotRevision(revision),
          id(provider),
          dotPolicyTerms(input),
        ),
    },
    [Channels.dotsRevokeResearch]: {
      count: 3,
      run: (value, policy, revision) =>
        requireDots().revokeResearch(dotId(value), dotId(policy), dotRevision(revision)),
    },
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
    [Channels.sendTeamTask]: { count: 2, run: (c, t) => service.sendTask(id(c), text(t), true) },
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
          error instanceof UserError ||
            error instanceof DotError ||
            error instanceof DotRepositoryError
            ? error.message
            : 'Unable to complete this action. Check the settings and try again.',
        );
      }
    });
}
