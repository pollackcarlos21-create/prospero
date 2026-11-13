import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopEvent } from './bridge';
import { Channels } from './ipc';
const bridge: DesktopBridge = {
  dots: Object.freeze({
    record: (id: string, query: import('@prospero/dots').DotRecordQuery) =>
      ipcRenderer.invoke(Channels.dotsRecord, id, query),
    context: (id: string, query = {}) => ipcRenderer.invoke(Channels.dotsContext, id, query),
    supervision: () => ipcRenderer.invoke(Channels.dotsSupervision),
    requests: (id: string, options = {}) => ipcRenderer.invoke(Channels.dotsRequests, id, options),
    reviewUnknown: (
      id: string,
      dotRevision: number,
      intentId: string,
      intentRevision: number,
      digest: string,
      input: import('./bridge').DotReviewInput,
    ) =>
      ipcRenderer.invoke(
        Channels.dotsReviewUnknown,
        id,
        dotRevision,
        intentId,
        intentRevision,
        digest,
        input,
      ),
    scheduleWake: (id: string, revision: number, policyId: string, dueAt: number) =>
      ipcRenderer.invoke(Channels.dotsScheduleWake, id, revision, policyId, dueAt),
    cancelWake: (id: string, wakeId: string, revision: number) =>
      ipcRenderer.invoke(Channels.dotsCancelWake, id, wakeId, revision),
    list: (options = {}) => ipcRenderer.invoke(Channels.dotsList, options),
    get: (id: string) => ipcRenderer.invoke(Channels.dotsGet, id),
    create: (input: { name: string; goal: string }) =>
      ipcRenderer.invoke(Channels.dotsCreate, input),
    run: (id: string, revision: number, providerId: string) =>
      ipcRenderer.invoke(Channels.dotsRun, id, revision, providerId),
    stop: (id: string) => ipcRenderer.invoke(Channels.dotsStop, id),
    transition: (id: string, revision: number, command: import('./bridge').DotControl) =>
      ipcRenderer.invoke(Channels.dotsTransition, id, revision, command),
    history: (id: string, options = {}) => ipcRenderer.invoke(Channels.dotsHistory, id, options),
    checkpoints: (id: string, options = {}) =>
      ipcRenderer.invoke(Channels.dotsCheckpoints, id, options),
    decide: (
      id: string,
      revision: number,
      intentId: string,
      intentRevision: number,
      digest: string,
      decision: 'approve' | 'deny',
    ) =>
      ipcRenderer.invoke(
        Channels.dotsDecide,
        id,
        revision,
        intentId,
        intentRevision,
        digest,
        decision,
      ),
    resumeApproval: (id: string, revision: number, intentId: string) =>
      ipcRenderer.invoke(Channels.dotsResumeApproval, id, revision, intentId),
    openSource: (id: string, intentId: string, sourceId: string) =>
      ipcRenderer.invoke(Channels.dotsOpenSource, id, intentId, sourceId),
    authorizeResearch: (
      id: string,
      revision: number,
      providerId: string,
      input: import('./bridge').DotPolicyTerms,
    ) => ipcRenderer.invoke(Channels.dotsAuthorizeResearch, id, revision, providerId, input),
    revokeResearch: (id: string, policyId: string, revision: number) =>
      ipcRenderer.invoke(Channels.dotsRevokeResearch, id, policyId, revision),
  }),
  bootstrap: () => ipcRenderer.invoke(Channels.bootstrap),
  ready: () => ipcRenderer.invoke(Channels.ready),
  createConversation: () => ipcRenderer.invoke(Channels.createConversation),
  getConversation: (id) => ipcRenderer.invoke(Channels.getConversation, id),
  deleteConversation: (id) => ipcRenderer.invoke(Channels.deleteConversation, id),
  renameConversation: (id, title) => ipcRenderer.invoke(Channels.renameConversation, id, title),
  showContextMenu: (target) => ipcRenderer.invoke(Channels.showContextMenu, target),
  copyText: (text) => ipcRenderer.invoke(Channels.copyText, text),
  selectProvider: (id, providerId) => ipcRenderer.invoke(Channels.selectProvider, id, providerId),
  chooseWorkspace: (id) => ipcRenderer.invoke(Channels.chooseWorkspace, id),
  attachFiles: (id) => ipcRenderer.invoke(Channels.attachFiles, id),
  addScope: (id, mode) => ipcRenderer.invoke(Channels.addScope, id, mode),
  removeScope: (id, scopeId) => ipcRenderer.invoke(Channels.removeScope, id, scopeId),
  decideActionPlan: (id, requestId, digest, decision) =>
    ipcRenderer.invoke(Channels.decideActionPlan, id, requestId, digest, decision),
  decideResearch: (id, requestId, digest, decision) =>
    ipcRenderer.invoke(Channels.decideResearch, id, requestId, digest, decision),
  saveWebSearch: (input) => ipcRenderer.invoke(Channels.saveWebSearch, input),
  testWebSearch: (input) => ipcRenderer.invoke(Channels.testWebSearch, input),
  openSource: (id, sourceId) => ipcRenderer.invoke(Channels.openSource, id, sourceId),
  sendTask: (id, text) => ipcRenderer.invoke(Channels.sendTask, id, text),
  sendTeamTask: (id, text) => ipcRenderer.invoke(Channels.sendTeamTask, id, text),
  stopTask: (id) => ipcRenderer.invoke(Channels.stopTask, id),
  decidePermission: (id, requestId, decision) =>
    ipcRenderer.invoke(Channels.decidePermission, id, requestId, decision),
  saveProvider: (input) => ipcRenderer.invoke(Channels.saveProvider, input),
  deleteProvider: (id) => ipcRenderer.invoke(Channels.deleteProvider, id),
  testProvider: (input) => ipcRenderer.invoke(Channels.testProvider, input),
  saveSettings: (settings) => ipcRenderer.invoke(Channels.saveSettings, settings),
  onEvent: (listener) => {
    const handle = (_event: Electron.IpcRendererEvent, data: DesktopEvent) => listener(data);
    ipcRenderer.on(Channels.event, handle);
    return () => ipcRenderer.removeListener(Channels.event, handle);
  },
};
contextBridge.exposeInMainWorld('prospero', Object.freeze(bridge));
