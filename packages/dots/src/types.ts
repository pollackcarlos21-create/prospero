declare const dotIdBrand: unique symbol;
declare const dotRunIdBrand: unique symbol;

export type DotId = string & { readonly [dotIdBrand]: true };
export type DotRunId = string & { readonly [dotRunIdBrand]: true };

export const DotLifecycleStatuses = Object.freeze({
  active: 'active',
  paused: 'paused',
  completed: 'completed',
  cancelled: 'cancelled',
  archived: 'archived',
} as const);
export type DotLifecycleStatus = (typeof DotLifecycleStatuses)[keyof typeof DotLifecycleStatuses];

export const DotRunStatuses = Object.freeze({
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
} as const);
export type DotRunStatus = (typeof DotRunStatuses)[keyof typeof DotRunStatuses];
export type DotRunOutcome = Exclude<DotRunStatus, 'pending' | 'running'>;

export interface DotGoal {
  readonly text: string;
}

/** Long-lived identity and goal; run failure does not change this lifecycle. */
export interface Dot {
  readonly id: DotId;
  readonly name: string;
  readonly goal: DotGoal;
  readonly lifecycle: DotLifecycleStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  readonly inFlightRunId?: DotRunId;
}

interface RunIdentity {
  readonly id: DotRunId;
  readonly dotId: DotId;
  /** Revision of the paired Dot snapshot, including this run transition. */
  readonly dotRevision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type DotRun = RunIdentity &
  (
    | {
        readonly status: 'pending';
        readonly startedAt?: never;
        readonly finishedAt?: never;
      }
    | {
        readonly status: 'running';
        readonly startedAt: number;
        readonly finishedAt?: never;
      }
    | {
        readonly status: 'succeeded' | 'failed';
        readonly startedAt: number;
        readonly finishedAt: number;
      }
    | {
        readonly status: 'cancelled' | 'interrupted';
        readonly startedAt?: number;
        readonly finishedAt: number;
      }
  );

/** Persist both snapshots atomically in a future store; this is not a lock. */
export interface DotRunChange {
  readonly dot: Dot;
  readonly run: DotRun;
}
