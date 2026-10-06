/** Execution time excludes approval waits; both waiting and total elapsed time remain bounded. */
export class ExecutionBudget {
  error?: string;
  private remaining: number;
  private activeSince = performance.now();
  private activeTimer?: ReturnType<typeof setTimeout>;
  private permissionTimer?: ReturnType<typeof setTimeout>;
  private readonly wallTimer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly limits: { executionMs: number; permissionMs: number; wallMs: number },
    private readonly abort: () => void,
  ) {
    this.remaining = limits.executionMs;
    this.wallTimer = setTimeout(
      () => this.expire('Task wall-clock time limit reached. Start a new task to continue.'),
      limits.wallMs,
    );
    this.startActive();
  }

  private expire(message: string) {
    if (this.error) return;
    this.error = message;
    this.abort();
  }

  private startActive() {
    if (this.error) return;
    this.activeSince = performance.now();
    if (this.remaining <= 0) {
      this.expire('Execution time limit reached. Start a new task to continue.');
      return;
    }
    this.activeTimer = setTimeout(
      () => this.expire('Execution time limit reached. Start a new task to continue.'),
      this.remaining,
    );
  }

  beginPermissionWait() {
    this.remaining -= performance.now() - this.activeSince;
    clearTimeout(this.activeTimer);
    this.activeTimer = undefined;
    if (this.remaining <= 0) {
      this.expire('Execution time limit reached. Start a new task to continue.');
      return;
    }
    this.permissionTimer = setTimeout(
      () => this.expire('Permission wait time limit reached. Start a new task to continue.'),
      this.limits.permissionMs,
    );
  }

  endPermissionWait() {
    clearTimeout(this.permissionTimer);
    this.permissionTimer = undefined;
    this.startActive();
  }

  dispose() {
    clearTimeout(this.activeTimer);
    clearTimeout(this.permissionTimer);
    clearTimeout(this.wallTimer);
  }
}
