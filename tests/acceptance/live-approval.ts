import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PermissionRequest } from '../../packages/core/src';

export class LiveApprovalError extends Error {
  constructor(readonly reason: 'review' | 'snapshot' | 'scope' | 'expired' | 'used') {
    super(`Live acceptance approval rejected the snapshot: ${reason}.`);
  }
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  throw new LiveApprovalError('snapshot');
}

export function livePermissionFingerprint(request: PermissionRequest): string {
  try {
    return createHash('sha256')
      .update(`prospero-live-permission:v1\n${JSON.stringify(canonical(request))}`)
      .digest('hex');
  } catch {
    throw new LiveApprovalError('snapshot');
  }
}

export interface LiveFixtureBoundary {
  /** Already canonicalized dedicated temporary roots, selected by the trusted caller. */
  readonly roots: readonly string[];
  readonly scopeIds: readonly string[];
}

const claimedSnapshots = new Set<string>();

function checkBoundary(request: PermissionRequest, boundary: LiveFixtureBoundary) {
  if (request.allowSession || !['plan', 'research'].includes(request.preview.kind))
    throw new LiveApprovalError('scope');
  if (request.preview.kind === 'research') {
    if (
      request.call.name !== 'authorize_research' ||
      !request.preview.research ||
      request.preview.plan
    )
      throw new LiveApprovalError('snapshot');
    return;
  }
  const plan = request.preview.plan;
  if (
    request.call.name !== 'execute_plan' ||
    !plan ||
    request.preview.research ||
    !plan.actions.length ||
    !plan.scopeIds.length ||
    plan.scopeIds.some((id) => !boundary.scopeIds.includes(id))
  )
    throw new LiveApprovalError('scope');
  for (const action of plan.actions) {
    if (
      ![
        'create_directory',
        'write_text',
        'copy_file',
        'move_file',
        'rename_file',
        'trash_file',
      ].includes(action.kind)
    )
      throw new LiveApprovalError('scope');
    if (
      action.effects.some((effect) => !['file.read', 'file.write', 'file.remove'].includes(effect))
    )
      throw new LiveApprovalError('scope');
    for (const target of [action.source, action.target].filter((value) => value !== undefined)) {
      if (
        !path.isAbsolute(target) ||
        path.normalize(target) !== target ||
        !boundary.roots.some((root) => {
          const relative = path.relative(root, target);
          return (
            relative.length > 0 &&
            relative !== '..' &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
          );
        })
      )
        throw new LiveApprovalError('scope');
    }
  }
}

/** Test-only preparation. A caller flag is not proof of human consent. Only a trusted
 * runner may create this after actual review of the full main-owned snapshot, and must
 * journal that review separately. This class grants no scope or persistent authority.
 */
export class ReviewedLivePermission {
  readonly fingerprint: string;
  private used = false;
  private readonly boundary: LiveFixtureBoundary;
  private readonly humanReviewed: boolean;
  private readonly expiresAt: number;
  private readonly now: () => number;
  constructor(
    request: PermissionRequest,
    options: {
      boundary: LiveFixtureBoundary;
      humanReviewed?: boolean;
      expiresAt: number;
      now?: () => number;
    },
  ) {
    if (
      !options.boundary.roots.length ||
      options.boundary.roots.some(
        (root) =>
          !path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root,
      ) ||
      !options.boundary.scopeIds.length ||
      !Number.isSafeInteger(options.expiresAt)
    )
      throw new LiveApprovalError('scope');
    this.boundary = Object.freeze({
      roots: Object.freeze([...options.boundary.roots]),
      scopeIds: Object.freeze([...options.boundary.scopeIds]),
    });
    this.humanReviewed = options.humanReviewed === true;
    this.expiresAt = options.expiresAt;
    this.now = options.now ?? Date.now;
    checkBoundary(request, this.boundary);
    this.fingerprint = livePermissionFingerprint(request);
  }
  claim(request: PermissionRequest): 'allow-once' {
    if (this.used || claimedSnapshots.has(this.fingerprint)) throw new LiveApprovalError('used');
    if (!this.humanReviewed) throw new LiveApprovalError('review');
    const now = this.now();
    if (!Number.isFinite(now) || now >= this.expiresAt) throw new LiveApprovalError('expired');
    checkBoundary(request, this.boundary);
    if (livePermissionFingerprint(request) !== this.fingerprint)
      throw new LiveApprovalError('snapshot');
    this.used = true;
    claimedSnapshots.add(this.fingerprint);
    return 'allow-once';
  }
}
