import { ProsperoStore, DotRepositoryError } from '../index';
import { DatabaseSync } from 'node:sqlite';
import { createDotRepository } from '../dot-repository';

const [mode, path, phase] = process.argv.slice(2);
if (!path) throw new Error('A test database path is required.');
if (mode === 'crash-before-commit') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.function('exit_before_commit', (revision, runCount) => {
    process.stdout.write(`${JSON.stringify({ stagedRevision: revision, runCount })}\n`);
    process.exit(24);
  });
  // Test-only injection into the same factory as the public facade. The temporary
  // trigger exits after the Dot update, before the Run insert or transaction commit.
  db.exec(`
    CREATE TEMP TRIGGER exit_before_pair_commit BEFORE INSERT ON dot_runs
    BEGIN
      SELECT exit_before_commit(
        (SELECT revision FROM dots WHERE id=NEW.dot_id),
        (SELECT COUNT(*) FROM dot_runs)
      );
    END;
  `);
  createDotRepository(db).createRun('dot-child', 0, { id: 'run-child', createdAt: 20 });
  throw new Error('The crash injection did not execute.');
}
const store = new ProsperoStore(path);
const repo = store.dots();

if (mode === 'write') {
  const dot = repo.create({
    id: 'dot-child',
    name: 'Researcher',
    goal: { text: 'Maintain an evolving research brief.' },
    createdAt: 10,
  });
  let pair = repo.createRun(dot.id, dot.revision, { id: 'run-child', createdAt: 20 });
  if (phase === 'running') pair = repo.startRun(dot.id, pair.run.id, pair.dot.revision, 30);
  process.stdout.write(`${JSON.stringify(pair)}\n`);
  // Intentionally leave the connection open: the committed WAL must survive process exit.
  process.exit(23);
} else if (mode === 'read') {
  const dot = repo.get('dot-child');
  const run = repo.getRun('run-child');
  process.stdout.write(
    `${JSON.stringify({
      dot,
      run,
      history: repo.runs('dot-child'),
      frozen: Object.isFrozen(dot) && Object.isFrozen(dot?.goal) && Object.isFrozen(run),
    })}\n`,
  );
  store.close();
} else if (mode === 'cas') {
  const dot = repo.get('shared');
  if (!dot) throw new Error('The shared fixture Dot is missing.');
  process.stdout.write(`${JSON.stringify({ ready: true, revision: dot.revision })}\n`);
  const released = await Bun.stdin.text();
  if (released !== 'go') throw new Error('The fixture barrier was not released.');
  try {
    const updated = repo.transition(dot.id, dot.revision, 'pause', 20);
    process.stdout.write(`${JSON.stringify({ kind: 'success', dot: updated })}\n`);
  } catch (error) {
    if (!(error instanceof DotRepositoryError)) throw error;
    process.stdout.write(`${JSON.stringify({ kind: 'error', code: error.code })}\n`);
  } finally {
    store.close();
  }
} else {
  store.close();
  throw new Error('Unknown repository test process mode.');
}
