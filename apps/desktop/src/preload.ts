import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopEvent } from './bridge';
import { Channels } from './ipc';
const bridge: DesktopBridge = {
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
