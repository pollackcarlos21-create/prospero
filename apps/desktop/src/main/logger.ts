import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export type DiagnosticCode =
  | 'app.ready'
  | 'app.failure'
  | 'ipc.rejected'
  | 'renderer.crash'
  | 'shutdown.failure';
/** Only fixed event codes and scalar diagnostic metadata; never request bodies or conversations. */
export function createLogger(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return (
    code: DiagnosticCode,
    metadata: { process?: 'main' | 'renderer'; exitCode?: number } = {},
  ) => {
    try {
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), code, ...metadata })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* Logging must not crash the product. */
    }
  };
}
