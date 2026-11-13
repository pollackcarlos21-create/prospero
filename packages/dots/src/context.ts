/** Terminal Run history is evidence; reading it never restores an execution grant. */
export interface DotContextQuery {
  readonly runId?: string;
  readonly beforeRunId?: string;
  readonly requestOffset?: number;
}
