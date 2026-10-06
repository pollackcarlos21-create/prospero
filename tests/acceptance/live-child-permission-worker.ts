import { DesktopService } from '../../apps/desktop/src/main/service';
import { livePermissionFingerprint } from './live-approval';
import {
  copyLivePermissionRequest,
  freezeLivePermissionValue,
  LIVE_PERMISSION_MESSAGE_BYTES,
  livePermissionId,
  livePermissionKeys,
  sameLivePermissionBinding,
  validateLivePermissionBinding,
  type LiveChildPermissionBinding,
  type LivePermissionChildMessage,
  type LivePermissionParentMessage,
} from './live-child-permission';

const attached = new Set<string>();
/** Acceptance-only actual Node main worker. Only the reviewed, inherited IPC channel carries
 * requests. stdout, model text and JSON claims cannot authorize a plan. No native binding or
 * external network is selected here, and this does not constitute a complete Electron runner.
 */
export function attachLiveChildPermissionWorker(input: {
  service: DesktopService;
  binding: LiveChildPermissionBinding;
  expiresAt: number;
}) {
  const service = input.service;
  const binding = freezeLivePermissionValue(structuredClone(input.binding));
  validateLivePermissionBinding(binding);
  const expiresAt = input.expiresAt;
  const key = `${binding.runId}/${binding.generationId}`;
  if (
    !(service instanceof DesktopService) ||
    !process.send ||
    !process.connected ||
    attached.has(key) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt - Date.now() > 1800000 ||
    service.getConversation(binding.conversationId).id !== binding.conversationId
  )
    throw new Error('The actual child permission worker is unavailable.');
  attached.add(key);
  const control = new AbortController();
  let nonce: string | undefined;
  let published: { requestId: string; fingerprint: string } | undefined;
  let decisionUsed = false;
  let closed = false;
  let bytes = 0;
  let frames = 0;
  let helloReceived = false;
  let refreshReceived = false;
  let refreshSent = false;
  let decisionReceived = false;
  let operation = Promise.resolve();
  let stopping: Promise<void> | undefined;
  const active = () => {
    if (closed || control.signal.aborted || Date.now() >= expiresAt)
      throw new Error('The child permission session has ended.');
  };
  const cleanup = () => {
    clearTimeout(timer);
    process.removeListener('message', message);
    process.removeListener('disconnect', fail);
  };
  const stop = () => {
    stopping ??= service.stopTask(binding.conversationId);
    void stopping.catch(() => {});
  };
  const fail = () => {
    if (closed) return;
    closed = true;
    control.abort();
    cleanup();
    stop();
    try {
      process.disconnect?.();
    } catch {}
  };
  const send = (value: LivePermissionChildMessage) =>
    new Promise<void>((resolve, reject) => {
      try {
        active();
        const ipcSend = process.send?.bind(process);
        if (!ipcSend || !process.connected) throw new Error('Disconnected');
        ipcSend(value, (error) => {
          if (error) reject(new Error('IPC failed'));
          else {
            try {
              active();
              resolve();
            } catch {
              reject(new Error('Session ended'));
            }
          }
        });
      } catch {
        reject(new Error('Child permission send failed'));
      }
    });
  const snapshot = () => service.getConversation(binding.conversationId).pendingPermission;
  const publishPending = () => {
    if (closed || !nonce || decisionUsed) return;
    try {
      active();
      const request = snapshot();
      if (!request) return;
      const copied = copyLivePermissionRequest(request);
      const fingerprint = livePermissionFingerprint(copied);
      if (published) {
        if (published.requestId !== copied.requestId || published.fingerprint !== fingerprint)
          throw new Error('Pending changed');
        return;
      }
      published = { requestId: copied.requestId, fingerprint };
      void send({
        version: 1,
        type: 'permission-snapshot',
        binding,
        nonce,
        challengeId: null,
        request: copied,
      }).catch(fail);
    } catch {
      fail();
    }
  };
  const receive = async (input: LivePermissionParentMessage) => {
    active();
    const value = input;
    if (input?.version !== 1 || !sameLivePermissionBinding(input.binding, binding))
      throw new Error('Wrong binding');
    if (
      input.type === 'permission-session' &&
      livePermissionKeys(value, ['version', 'type', 'binding', 'nonce', 'expiresAt']) &&
      !nonce &&
      livePermissionId(input.nonce) &&
      input.expiresAt === expiresAt
    ) {
      nonce = input.nonce;
      publishPending();
      return;
    }
    if (!nonce || input.nonce !== nonce || !published || decisionUsed)
      throw new Error('Wrong session');
    if (
      input.type === 'permission-refresh' &&
      livePermissionKeys(value, [
        'version',
        'type',
        'binding',
        'nonce',
        'requestId',
        'challengeId',
      ]) &&
      input.requestId === published.requestId &&
      livePermissionId(input.challengeId)
    ) {
      const current = snapshot();
      const request = current ? copyLivePermissionRequest(current) : null;
      refreshSent = true;
      await send({
        version: 1,
        type: 'permission-snapshot',
        binding,
        nonce,
        challengeId: input.challengeId,
        request,
      });
      return;
    }
    if (
      input.type === 'permission-decision' &&
      livePermissionKeys(value, [
        'version',
        'type',
        'binding',
        'nonce',
        'requestId',
        'fingerprint',
        'decision',
      ]) &&
      input.requestId === published.requestId &&
      input.fingerprint === published.fingerprint &&
      ['allow-once', 'deny'].includes(input.decision)
    ) {
      const current = snapshot();
      if (
        !current ||
        current.requestId !== input.requestId ||
        livePermissionFingerprint(current) !== input.fingerprint ||
        current.call.name !== 'execute_plan' ||
        !current.preview.plan ||
        current.preview.kind !== 'plan' ||
        current.allowSession
      )
        throw new Error('Stale pending');
      active();
      decisionUsed = true;
      service.decideActionPlan(
        binding.conversationId,
        current.requestId,
        current.preview.plan.digest,
        input.decision,
      );
      await send({
        version: 1,
        type: 'permission-ack',
        binding,
        nonce,
        requestId: input.requestId,
        fingerprint: input.fingerprint,
        decision: input.decision,
      });
      return;
    }
    throw new Error('Unexpected permission frame');
  };
  const message = (value: unknown) => {
    if (closed) return;
    try {
      active();
      const body = JSON.stringify(value);
      if (typeof body !== 'string') throw new Error('Protocol frame cap');
      bytes += Buffer.byteLength(body);
      if (
        Buffer.byteLength(body) > LIVE_PERMISSION_MESSAGE_BYTES ||
        ++frames > 16 ||
        bytes > 262144
      )
        throw new Error('Protocol frame cap');
      const frame = freezeLivePermissionValue(JSON.parse(body)) as LivePermissionParentMessage;
      if (frame?.version !== 1 || !sameLivePermissionBinding(frame.binding, binding))
        throw new Error('Wrong binding');
      if (frame.type === 'permission-session') {
        if (helloReceived || nonce) throw new Error('Repeated hello');
        helloReceived = true;
      } else if (frame.type === 'permission-refresh') {
        if (!nonce || !published || refreshReceived || decisionUsed)
          throw new Error('Unexpected refresh');
        refreshReceived = true;
      } else if (frame.type === 'permission-decision') {
        if (!refreshSent || decisionReceived || decisionUsed)
          throw new Error('Early/repeated decision');
        decisionReceived = true;
      } else throw new Error('Unexpected frame');
      operation = operation.then(() => receive(frame)).catch(fail);
    } catch {
      fail();
    }
  };
  const timer = setTimeout(fail, Math.max(1, expiresAt - Date.now()));
  process.on('message', message);
  process.once('disconnect', fail);
  void send({ version: 1, type: 'permission-ready', binding }).catch(fail);
  return Object.freeze({
    publishPending,
    async close() {
      if (!closed) {
        closed = true;
        control.abort();
        cleanup();
        stop();
      }
      await stopping;
    },
  });
}
