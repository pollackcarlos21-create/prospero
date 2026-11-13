import { UserError } from './validation';

export interface ExecutionOwner {
  readonly kind: 'chat' | 'dot';
  readonly id: string;
}

/** One application execution slot. Team members remain inside their lead's reservation. */
export class ExecutionAdmission {
  private current?: { owner: Readonly<ExecutionOwner>; token: symbol };
  private listeners = new Set<() => void>();
  subscribeFree(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get owner(): Readonly<ExecutionOwner> | undefined {
    return this.current?.owner;
  }

  acquire(owner: ExecutionOwner): { release(): void } {
    if (
      !owner ||
      !['chat', 'dot'].includes(owner.kind) ||
      typeof owner.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(owner.id)
    )
      throw new UserError('Invalid execution owner.');
    if (this.current)
      throw new UserError('Finish or stop the running task or Dot before starting another.');
    const token = Symbol('execution-reservation');
    this.current = { owner: Object.freeze({ kind: owner.kind, id: owner.id }), token };
    return Object.freeze({
      release: () => {
        if (this.current?.token === token) {
          this.current = undefined;
          for (const listener of this.listeners) {
            try {
              listener();
            } catch {
              /* Observers never retain or transfer ownership. */
            }
          }
        }
      },
    });
  }
}
