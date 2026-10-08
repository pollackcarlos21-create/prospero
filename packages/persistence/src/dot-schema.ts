import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './action-journal';
import { DotRepositoryError } from './dot-errors';

/** Additive migration only: no recovery or maintenance of existing profile records. */
export function migrateDots(db: DatabaseSync): void {
  try {
    transaction(db, () => {
      db.exec(`
      CREATE TABLE dots (
        id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','paused','completed','cancelled','archived')),
        created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
        updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN created_at AND 9007199254740991),
        in_flight_run_id TEXT,
        payload TEXT NOT NULL,
        CHECK(in_flight_run_id IS NULL OR lifecycle='active'),
        FOREIGN KEY(id,in_flight_run_id) REFERENCES dot_runs(dot_id,id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TABLE dot_runs (
        id TEXT PRIMARY KEY NOT NULL,
        dot_id TEXT NOT NULL REFERENCES dots(id),
        dot_revision INTEGER NOT NULL CHECK(typeof(dot_revision)='integer' AND dot_revision BETWEEN 1 AND 9007199254740991),
        status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','interrupted')),
        created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
        updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN created_at AND 9007199254740991),
        payload TEXT NOT NULL,
        UNIQUE(dot_id,id)
      );
      CREATE UNIQUE INDEX dot_runs_in_flight ON dot_runs(dot_id) WHERE status IN ('pending','running');
      CREATE INDEX dots_created ON dots(created_at,id);
      CREATE INDEX dot_runs_history ON dot_runs(dot_id,created_at,id);
      PRAGMA user_version=3;
      `);
    });
  } catch {
    throw new DotRepositoryError('storage-failure');
  }
}
