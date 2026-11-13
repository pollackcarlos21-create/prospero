import type { DotRepository } from '@prospero/persistence';
import type { DotSupervisionSnapshot } from '../bridge';
export interface DotAlertClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const systemClock: DotAlertClock = {
  now: Date.now,
  schedule: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};
export interface DotAlertPorts {
  snapshot(): Promise<DotSupervisionSnapshot>;
  publish(snapshot: DotSupervisionSnapshot): void;
  canNotify(): boolean;
  show(open: () => void): void;
  open(dotId: string): void | Promise<void>;
  failed(): void;
}
/** One generic native notice per batch; durable claims mean attempted, never OS-delivered. */
export class DotAlerts {
  private timer?: () => void;
  private recheck?: () => void;
  private generation = 0;
  private closed = false;
  constructor(
    private repository: DotRepository,
    private ports: DotAlertPorts,
    private clock: DotAlertClock = systemClock,
  ) {}
  refresh() {
    if (this.closed) return;
    this.generation++;
    this.recheck?.();
    this.recheck = undefined;
    if (this.timer) return;
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      void this.scan(this.generation);
    }, 50);
  }
  private async scan(generation: number) {
    try {
      const snapshot = await this.ports.snapshot();
      if (this.closed || generation !== this.generation) return;
      this.ports.publish(snapshot);
      if (snapshot.recheckAt !== undefined)
        this.recheck = this.clock.schedule(
          () => {
            this.recheck = undefined;
            this.refresh();
          },
          Math.min(30000, Math.max(50, snapshot.recheckAt - this.clock.now())),
        );
      if (!this.ports.canNotify()) return;
      const entries = this.repository.claimSupervisionAlerts(
        snapshot.items
          .filter((item) => !this.repository.alertClaim(item.intentId, item.kind))
          .slice(0, 20),
        this.clock.now(),
      );
      if (!entries.length || this.closed) return;
      this.ports.show(() => {
        if (this.closed) return;
        void Promise.resolve()
          .then(() => {
            if (!this.closed) return this.ports.open(entries[0].dotId);
          })
          .catch(() => this.ports.failed());
      });
    } catch {
      if (!this.closed) this.ports.failed();
    }
  }
  dispose() {
    this.closed = true;
    this.generation++;
    this.timer?.();
    this.recheck?.();
    this.recheck = undefined;
    this.timer = undefined;
  }
}
