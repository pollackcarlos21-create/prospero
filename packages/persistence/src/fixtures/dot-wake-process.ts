import { DatabaseSync } from 'node:sqlite';
import { createDotRepository } from '../dot-repository';
import { DotRepositoryError } from '../dot-errors';
const [mode, path, runId] = process.argv.slice(2);
if (!path || !runId) throw new Error('Owned fixture arguments required');
const db = new DatabaseSync(path);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode === 'crash-before') {
  db.function('exit_wake', () => process.exit(24));
  db.exec(
    "CREATE TEMP TRIGGER exit_before_wake_commit BEFORE UPDATE ON dot_wakes WHEN NEW.status='claimed' BEGIN SELECT exit_wake(); END",
  );
}
const repo = createDotRepository(db);
if (mode === 'cas') {
  process.stdout.write(`${JSON.stringify({ ready: repo.wake('wake')?.revision === 0 })}\n`);
  if ((await Bun.stdin.text()) !== 'go') throw new Error('Missing fixture barrier');
}
try {
  const result = repo.claimWake('wake', 0, {
    runId,
    at: 200,
    provider: { id: 'model', baseUrl: 'https://fixture.example.test/v1', model: 'fixture' },
    configurationRevision: 7,
  });
  if (mode === 'crash-after') process.exit(25);
  process.stdout.write(`${JSON.stringify({ kind: 'claimed', runId: result.pair?.run.id })}\n`);
} catch (error) {
  if (!(error instanceof DotRepositoryError)) throw error;
  process.stdout.write(`${JSON.stringify({ kind: 'error', code: error.code })}\n`);
}
db.close();
