export {
  createDot,
  pauseDot,
  resumeDot,
  completeDot,
  cancelDot,
  archiveDot,
  createDotRun,
  startDotRun,
  finishDotRun,
} from './domain';
export { DotError, type DotErrorCode } from './errors';
export { DotLifecycleStatuses, DotRunStatuses } from './types';
export type {
  Dot,
  DotId,
  DotGoal,
  DotLifecycleStatus,
  DotRun,
  DotRunId,
  DotRunStatus,
  DotRunOutcome,
  DotRunChange,
} from './types';
