import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PermissionRequest } from '../../packages/core/src';
import {
  livePermissionFingerprint,
  ReviewedLivePermission,
  type LiveFixtureBoundary,
} from './live-approval';

export interface LiveChildPermissionBinding {
  readonly runId: string;
  readonly generationId: string;
  readonly caseId: 'C07';
  readonly phaseId: 'initial' | 'after-crash';
  readonly conversationId: string;
}
export interface LiveParentPermissionSession {
  evidence(): Readonly<{
    status: 'not-started' | 'pending' | 'acknowledged' | 'denied';
    reason: string | null;
    records: readonly Readonly<{
      requestId: string;
      fingerprint: string;
      decision: 'allow-once' | 'deny';
      acknowledged: boolean;
    }>[];
    receivedBytes: number;
    binding: LiveChildPermissionBinding;
    ackMeaning: 'service-decision-admitted; not-durable-or-effect-proof';
  }>;
}
interface Envelope {
  readonly version: 1;
  readonly binding: LiveChildPermissionBinding;
}
export type LivePermissionChildMessage =
  | (Envelope & { readonly type: 'permission-ready' })
  | (Envelope & {
      readonly type: 'permission-snapshot';
      readonly nonce: string;
      readonly challengeId: string | null;
      readonly request: PermissionRequest | null;
    })
  | (Envelope & {
      readonly type: 'permission-ack';
      readonly nonce: string;
      readonly requestId: string;
      readonly fingerprint: string;
      readonly decision: 'allow-once' | 'deny';
    });
export type LivePermissionParentMessage =
  | (Envelope & {
      readonly type: 'permission-session';
      readonly nonce: string;
      readonly expiresAt: number;
    })
  | (Envelope & {
      readonly type: 'permission-refresh';
      readonly nonce: string;
      readonly requestId: string;
      readonly challengeId: string;
    })
  | (Envelope & {
      readonly type: 'permission-decision';
      readonly nonce: string;
      readonly requestId: string;
      readonly fingerprint: string;
      readonly decision: 'allow-once' | 'deny';
    });
export const LIVE_PERMISSION_MESSAGE_BYTES = 65536;
const TOTAL_BYTES = 262144;
export const livePermissionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export function livePermissionKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
export function validateLivePermissionBinding(value: LiveChildPermissionBinding): void {
  if (
    !livePermissionKeys(value, ['runId', 'generationId', 'caseId', 'phaseId', 'conversationId']) ||
    !livePermissionId(value.runId) ||
    !livePermissionId(value.generationId) ||
    !livePermissionId(value.conversationId) ||
    value.caseId !== 'C07' ||
    !['initial', 'after-crash'].includes(value.phaseId)
  )
    invalid();
}
export function sameLivePermissionBinding(
  left: unknown,
  right: LiveChildPermissionBinding,
): boolean {
  try {
    validateLivePermissionBinding(left as LiveChildPermissionBinding);
    return (['runId', 'generationId', 'caseId', 'phaseId', 'conversationId'] as const).every(
      (key) => (left as LiveChildPermissionBinding)[key] === right[key],
    );
  } catch {
    return false;
  }
}
function invalid(): never {
  throw new Error('The reviewed child permission protocol is inconsistent.');
}
export function freezeLivePermissionValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeLivePermissionValue(child);
    Object.freeze(value);
  }
  return value;
}
export function isLiveChildPermissionMessage(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('permission-')
  );
}
export function copyLivePermissionRequest(value: PermissionRequest): PermissionRequest {
  const body = JSON.stringify(value);
  if (
    typeof body !== 'string' ||
    Buffer.byteLength(body) > LIVE_PERMISSION_MESSAGE_BYTES ||
    !value ||
    !livePermissionId(value.requestId)
  )
    invalid();
  const copied = JSON.parse(body) as PermissionRequest;
  livePermissionFingerprint(copied);
  return freezeLivePermissionValue(copied);
}
interface Owner {
  attach(
    send: (message: LivePermissionParentMessage) => Promise<void>,
    stop: () => void,
    signal: AbortSignal,
  ): { receive(value: unknown): void; finish(): void };
  used: boolean;
  matches(request: PermissionRequest, conversationId: string, phaseId: string): boolean;
}
const owners = new WeakMap<LiveParentPermissionSession, Owner>();
/** Main-only technical protocol. Review callbacks must be the trusted human workflow; their
 * return value cannot independently prove consent. Only fixed C07 fixture plans are eligible.
 * No complete request, file text, key, provider header or IPC stdout is exported as evidence.
 */
export function createLiveParentPermissionSession(input: {
  binding: LiveChildPermissionBinding;
  boundary: LiveFixtureBoundary;
  expiresAt: number;
  assertCurrent(signal: AbortSignal): Promise<void>;
  reviewPermission?(
    input: Readonly<{
      request: PermissionRequest;
      fingerprint: string;
      binding: LiveChildPermissionBinding;
    }>,
    signal: AbortSignal,
  ): Promise<'allow-once' | 'deny'>;
}): LiveParentPermissionSession {
  validateLivePermissionBinding(input.binding);
  const binding = freezeLivePermissionValue(structuredClone(input.binding));
  const boundary = freezeLivePermissionValue(structuredClone(input.boundary));
  const expiresAt = input.expiresAt;
  const assertCurrent = input.assertCurrent;
  const review = input.reviewPermission;
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt - Date.now() > 1800000 ||
    typeof assertCurrent !== 'function' ||
    (review !== undefined && typeof review !== 'function') ||
    boundary.roots.length !== 1 ||
    boundary.scopeIds.length !== 1
  )
    invalid();
  let status: ReturnType<LiveParentPermissionSession['evidence']>['status'] = 'not-started';
  let reason: string | null = null;
  let receivedBytes = 0;
  let reviewedAllow = false;
  const records: {
    requestId: string;
    fingerprint: string;
    decision: 'allow-once' | 'deny';
    acknowledged: boolean;
  }[] = [];
  const session: LiveParentPermissionSession = Object.freeze({
    evidence() {
      return Object.freeze({
        status,
        reason,
        receivedBytes,
        binding,
        ackMeaning: 'service-decision-admitted; not-durable-or-effect-proof' as const,
        records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
      });
    },
  });
  owners.set(session, {
    used: false,
    matches(request, conversationId, phaseId) {
      return (
        reviewedAllow &&
        conversationId === binding.conversationId &&
        phaseId === binding.phaseId &&
        records.length === 1 &&
        records[0].decision === 'allow-once' &&
        records[0].requestId === request.requestId &&
        records[0].fingerprint === livePermissionFingerprint(request)
      );
    },
    attach(send, stop, outerSignal) {
      const control = new AbortController();
      const signal = AbortSignal.any([control.signal, outerSignal]);
      const nonce = randomUUID();
      let state: 'ready' | 'snapshot' | 'review' | 'refresh' | 'ack' | 'done' | 'closed' = 'ready';
      let messages = 0;
      let request: PermissionRequest | undefined;
      let fingerprint = '';
      let challengeId = '';
      let decision: 'allow-once' | 'deny' = 'deny';
      let operation = Promise.resolve();
      const received = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (failure: string) => {
        if (state === 'closed') return;
        state = 'closed';
        status = 'pending';
        reason = failure;
        control.abort();
        if (timer) clearTimeout(timer);
        stop();
      };
      const active = () => {
        signal.throwIfAborted();
        if (state === 'closed' || Date.now() >= expiresAt) invalid();
      };
      const check = async () => {
        active();
        await assertCurrent(signal);
        active();
      };
      const emit = async (message: LivePermissionParentMessage) => {
        active();
        await send(message);
        active();
      };
      const frame = (type: LivePermissionParentMessage['type']) => ({
        version: 1 as const,
        type,
        binding,
        nonce,
      });
      const validRequest = (snapshot: PermissionRequest) => {
        const copied = copyLivePermissionRequest(snapshot);
        // Reuse the existing exact snapshot and root/effect validator; no session grant.
        new ReviewedLivePermission(copied, { boundary, expiresAt });
        const plan = copied.preview.plan;
        const names =
          binding.phaseId === 'initial' ? ['first.txt', 'second.txt', 'third.txt'] : ['third.txt'];
        if (
          !plan ||
          plan.actions.length !== names.length ||
          plan.actions.some(
            (action, index) =>
              action.kind !== 'write_text' ||
              action.target !== join(boundary.roots[0], names[index]) ||
              action.source !== undefined,
          )
        )
          invalid();
        return copied;
      };
      const parse = (value: unknown) => {
        const serialized = JSON.stringify(value);
        if (
          typeof serialized !== 'string' ||
          Buffer.byteLength(serialized) > LIVE_PERMISSION_MESSAGE_BYTES ||
          ++messages > 16
        )
          invalid();
        receivedBytes += Buffer.byteLength(serialized);
        if (receivedBytes > TOTAL_BYTES) invalid();
        value = freezeLivePermissionValue(JSON.parse(serialized));
        if (
          !value ||
          typeof value !== 'object' ||
          (value as Envelope).version !== 1 ||
          !sameLivePermissionBinding((value as Envelope).binding, binding)
        )
          invalid();
        const message = value as LivePermissionChildMessage;
        if (
          message.type === 'permission-ready' &&
          livePermissionKeys(value, ['version', 'type', 'binding'])
        )
          return message;
        if (
          message.type === 'permission-snapshot' &&
          livePermissionKeys(value, [
            'version',
            'type',
            'binding',
            'nonce',
            'challengeId',
            'request',
          ]) &&
          message.nonce === nonce &&
          (message.challengeId === null || livePermissionId(message.challengeId))
        )
          return message;
        if (
          message.type === 'permission-ack' &&
          livePermissionKeys(value, [
            'version',
            'type',
            'binding',
            'nonce',
            'requestId',
            'fingerprint',
            'decision',
          ]) &&
          message.nonce === nonce &&
          livePermissionId(message.requestId) &&
          /^[a-f0-9]{64}$/.test(message.fingerprint) &&
          ['allow-once', 'deny'].includes(message.decision)
        )
          return message;
        return invalid();
      };
      const receive = async (message: LivePermissionChildMessage) => {
        active();
        if (message.type === 'permission-ready') {
          if (state !== 'ready') invalid();
          await check();
          state = 'snapshot';
          status = 'pending';
          await emit({ ...frame('permission-session'), type: 'permission-session', expiresAt });
          return;
        }
        if (
          message.type === 'permission-snapshot' &&
          state === 'snapshot' &&
          message.challengeId === null &&
          message.request
        ) {
          request = validRequest(message.request);
          fingerprint = livePermissionFingerprint(request);
          state = 'review';
          await check();
          decision = review
            ? await review(Object.freeze({ request, fingerprint, binding }), signal)
            : 'deny';
          active();
          if (!['allow-once', 'deny'].includes(decision)) invalid();
          reviewedAllow = !!review && decision === 'allow-once';
          await check();
          challengeId = randomUUID();
          state = 'refresh';
          await emit({
            ...frame('permission-refresh'),
            type: 'permission-refresh',
            requestId: request.requestId,
            challengeId,
          });
          return;
        }
        if (
          message.type === 'permission-snapshot' &&
          state === 'refresh' &&
          message.challengeId === challengeId &&
          message.request &&
          request
        ) {
          const refreshed = validRequest(message.request);
          if (livePermissionFingerprint(refreshed) !== fingerprint) invalid();
          await check();
          if (decision === 'allow-once')
            new ReviewedLivePermission(request, { boundary, expiresAt, humanReviewed: true }).claim(
              refreshed,
            );
          state = 'ack';
          records.push({
            requestId: request.requestId,
            fingerprint,
            decision,
            acknowledged: false,
          });
          await emit({
            ...frame('permission-decision'),
            type: 'permission-decision',
            requestId: request.requestId,
            fingerprint,
            decision,
          });
          return;
        }
        if (
          message.type === 'permission-ack' &&
          state === 'ack' &&
          request &&
          message.requestId === request.requestId &&
          message.fingerprint === fingerprint &&
          message.decision === decision
        ) {
          await check();
          records[0].acknowledged = true;
          status = decision === 'deny' ? 'denied' : 'acknowledged';
          reason = null;
          state = 'done';
          if (timer) clearTimeout(timer);
          return;
        }
        invalid();
      };
      const abort = () => fail('stopped');
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => fail('deadline'), Math.max(1, expiresAt - Date.now()));
      if (signal.aborted) fail('stopped');
      return {
        receive(value) {
          if (state === 'closed') return;
          try {
            active();
            // Bound and copy at the actual IPC entry, before any human-review await. An
            // early ACK/refresh cannot wait in the queue and become valid after approval.
            const message = parse(value);
            const kind =
              message.type === 'permission-snapshot'
                ? message.challengeId === null
                  ? 'initial'
                  : 'refresh'
                : message.type;
            if (
              received.has(kind) ||
              (message.type === 'permission-ready' && state !== 'ready') ||
              (message.type === 'permission-snapshot' &&
                (message.challengeId === null
                  ? state !== 'snapshot'
                  : state !== 'refresh' || message.challengeId !== challengeId)) ||
              (message.type === 'permission-ack' && state !== 'ack')
            )
              invalid();
            received.add(kind);
            operation = operation.then(() => receive(message)).catch(() => fail('protocol'));
          } catch {
            fail('protocol');
          }
        },
        finish() {
          if (timer) clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (state !== 'done') {
            status = 'pending';
            reason ??= records.length ? 'ack-missing' : 'worker-ended';
          }
          state = 'closed';
          control.abort();
        },
      };
    },
  });
  return session;
}
/** Internal attachment used by the actual supervisor, exactly once. It grants no process,
 * network, native or human authority and cannot substitute for an actual exit receipt.
 */
export function attachLiveParentPermissionSession(
  session: LiveParentPermissionSession,
  send: (message: LivePermissionParentMessage) => Promise<void>,
  stop: () => void,
  signal: AbortSignal,
) {
  const owner = owners.get(session);
  if (!owner || owner.used || typeof send !== 'function' || typeof stop !== 'function') invalid();
  owner.used = true;
  return owner.attach(send, stop, signal);
}
export function assertLiveParentPermissionSession(session: LiveParentPermissionSession): void {
  const owner = owners.get(session);
  if (!owner || owner.used) invalid();
}
/** Inert comparison with an independently read durable decision. It never changes ACK,
 * restores a grant or proves human identity; no retry may be inferred from a missing ACK.
 */
export function matchesLiveParentPermissionDecision(
  session: LiveParentPermissionSession,
  request: PermissionRequest,
  conversationId: string,
  phaseId: string,
): boolean {
  const owner = owners.get(session);
  if (!owner) return false;
  try {
    return owner.matches(request, conversationId, phaseId);
  } catch {
    return false;
  }
}
