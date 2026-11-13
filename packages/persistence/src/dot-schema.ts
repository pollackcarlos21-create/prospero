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

export function migrateDotCheckpoints(db: DatabaseSync): void {
  try {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE dot_checkpoints (
          dot_id TEXT NOT NULL REFERENCES dots(id),
          run_id TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
          updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
          payload TEXT NOT NULL,
          UNIQUE(dot_id,revision),
          FOREIGN KEY(dot_id,run_id) REFERENCES dot_runs(dot_id,id)
        );
        PRAGMA user_version=4;
      `);
    });
  } catch {
    throw new DotRepositoryError('storage-failure');
  }
}

export function migrateDotIntents(db: DatabaseSync): void {
  try {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE dot_intents (
          id TEXT PRIMARY KEY NOT NULL,
          dot_id TEXT NOT NULL REFERENCES dots(id),
          run_id TEXT NOT NULL,
          dot_revision INTEGER NOT NULL CHECK(typeof(dot_revision)='integer' AND dot_revision BETWEEN 1 AND 9007199254740991),
          digest TEXT NOT NULL CHECK(length(digest)=64),
          binding TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','stale','cancelled','dispatching','succeeded','unknown')),
          revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
          updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
          dispatched_at INTEGER,
          receipt TEXT,
          FOREIGN KEY(dot_id,run_id) REFERENCES dot_runs(dot_id,id),
          CHECK((status IN ('dispatching','succeeded','unknown')) = (dispatched_at IS NOT NULL)),
          CHECK((status='succeeded') = (receipt IS NOT NULL))
        );
        CREATE UNIQUE INDEX dot_intents_open ON dot_intents(run_id) WHERE status IN ('pending','approved','dispatching','unknown');
        CREATE INDEX dot_intents_history ON dot_intents(dot_id,created_at,id);
        CREATE TRIGGER dot_intent_binding_immutable BEFORE UPDATE OF id,dot_id,run_id,dot_revision,digest,binding,created_at,expires_at ON dot_intents
          BEGIN SELECT RAISE(ABORT,'Dot intent binding is immutable.'); END;
        CREATE TABLE dot_intent_events (
          intent_id TEXT NOT NULL REFERENCES dot_intents(id),
          sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
          status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','stale','cancelled','dispatching','succeeded','unknown')),
          at INTEGER NOT NULL,
          PRIMARY KEY(intent_id,sequence)
        );
        CREATE TRIGGER dot_intent_events_no_update BEFORE UPDATE ON dot_intent_events
          BEGIN SELECT RAISE(ABORT,'Dot intent events are append-only.'); END;
        CREATE TRIGGER dot_intent_events_no_delete BEFORE DELETE ON dot_intent_events
          BEGIN SELECT RAISE(ABORT,'Dot intent events are append-only.'); END;
        PRAGMA user_version=5;
      `);
    });
  } catch {
    throw new DotRepositoryError('storage-failure');
  }
}

export function migrateDotPolicies(db: DatabaseSync): void {
  try {
    transaction(db, () =>
      db.exec(`
      CREATE TABLE dot_policies (
        id TEXT PRIMARY KEY NOT NULL,
        dot_id TEXT NOT NULL REFERENCES dots(id),
        binding TEXT NOT NULL,
        digest TEXT NOT NULL CHECK(length(digest)=64),
        status TEXT NOT NULL CHECK(status IN ('active','revoked')),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision IN (0,1)),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
        updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
        UNIQUE(dot_id,id)
      );
      CREATE UNIQUE INDEX dot_policy_active ON dot_policies(dot_id) WHERE status='active';
      CREATE TRIGGER dot_policy_binding_immutable BEFORE UPDATE OF id,dot_id,binding,digest,created_at,expires_at ON dot_policies
        BEGIN SELECT RAISE(ABORT,'Dot policy binding is immutable.'); END;
      CREATE TABLE dot_policy_usage (
        id TEXT PRIMARY KEY NOT NULL,
        policy_id TEXT NOT NULL,
        dot_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        intent_id TEXT REFERENCES dot_intents(id),
        kind TEXT NOT NULL CHECK(kind IN ('run','search','fetch')),
        model_turns INTEGER NOT NULL CHECK(typeof(model_turns)='integer' AND model_turns BETWEEN 0 AND 8),
        model_bytes INTEGER NOT NULL CHECK(typeof(model_bytes)='integer' AND model_bytes BETWEEN 0 AND 786432),
        body_bytes INTEGER NOT NULL CHECK(typeof(body_bytes)='integer' AND body_bytes BETWEEN 0 AND 1048576),
        at INTEGER NOT NULL,
        FOREIGN KEY(dot_id,policy_id) REFERENCES dot_policies(dot_id,id),
        FOREIGN KEY(dot_id,run_id) REFERENCES dot_runs(dot_id,id),
        CHECK((kind='run')=(intent_id IS NULL))
      );
      CREATE UNIQUE INDEX dot_policy_run ON dot_policy_usage(run_id) WHERE kind='run';
      CREATE UNIQUE INDEX dot_policy_intent ON dot_policy_usage(intent_id) WHERE intent_id IS NOT NULL;
      CREATE TRIGGER dot_policy_usage_no_update BEFORE UPDATE ON dot_policy_usage
        BEGIN SELECT RAISE(ABORT,'Dot policy usage is append-only.'); END;
      CREATE TRIGGER dot_policy_usage_no_delete BEFORE DELETE ON dot_policy_usage
        BEGIN SELECT RAISE(ABORT,'Dot policy usage is append-only.'); END;
      CREATE TABLE dot_policy_approvals (
        intent_id TEXT PRIMARY KEY NOT NULL REFERENCES dot_intents(id),
        policy_id TEXT NOT NULL REFERENCES dot_policies(id),
        digest TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TRIGGER dot_policy_approval_no_update BEFORE UPDATE ON dot_policy_approvals
        BEGIN SELECT RAISE(ABORT,'Dot policy approval is immutable.'); END;
      CREATE TRIGGER dot_policy_approval_no_delete BEFORE DELETE ON dot_policy_approvals
        BEGIN SELECT RAISE(ABORT,'Dot policy approval is immutable.'); END;
      PRAGMA user_version=6;
    `),
    );
  } catch {
    throw new DotRepositoryError('storage-failure');
  }
}
export function migrateDotWakes(db: DatabaseSync): void {
  try {
    transaction(db, () =>
      db.exec(`
    CREATE TABLE dot_wakes (
      id TEXT PRIMARY KEY NOT NULL,
      dot_id TEXT NOT NULL REFERENCES dots(id),
      policy_id TEXT NOT NULL,
      binding TEXT NOT NULL,
      digest TEXT NOT NULL CHECK(length(digest)=64),
      created_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL CHECK(due_at>created_at),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
      status TEXT NOT NULL CHECK(status IN ('scheduled','claimed','cancelled','blocked')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision IN (0,1)),
      run_id TEXT,
      reason TEXT CHECK(reason IN ('user','state','policy','configuration','budget','unknown')),
      FOREIGN KEY(dot_id,policy_id) REFERENCES dot_policies(dot_id,id),
      FOREIGN KEY(dot_id,run_id) REFERENCES dot_runs(dot_id,id),
      CHECK((status='claimed')=(run_id IS NOT NULL)),
      CHECK((status IN ('cancelled','blocked'))=(reason IS NOT NULL))
    );
    CREATE UNIQUE INDEX dot_wake_pending ON dot_wakes(dot_id) WHERE status='scheduled';
    CREATE UNIQUE INDEX dot_wake_run ON dot_wakes(run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX dot_wakes_due ON dot_wakes(status,due_at,id);
    CREATE TRIGGER dot_wake_binding_immutable BEFORE UPDATE OF id,dot_id,policy_id,binding,digest,created_at,due_at ON dot_wakes
      BEGIN SELECT RAISE(ABORT,'Dot wake binding is immutable.'); END;
    CREATE TABLE dot_wake_events (
      wake_id TEXT NOT NULL REFERENCES dot_wakes(id),
      sequence INTEGER NOT NULL CHECK(sequence IN (1,2)),
      status TEXT NOT NULL CHECK(status IN ('scheduled','claimed','cancelled','blocked')),
      at INTEGER NOT NULL,
      reason TEXT,
      run_id TEXT REFERENCES dot_runs(id),
      CHECK((status='claimed')=(run_id IS NOT NULL)),
      PRIMARY KEY(wake_id,sequence)
    );
    CREATE TRIGGER dot_wake_events_no_update BEFORE UPDATE ON dot_wake_events
      BEGIN SELECT RAISE(ABORT,'Dot wake events are append-only.'); END;
    CREATE TRIGGER dot_wake_events_no_delete BEFORE DELETE ON dot_wake_events
      BEGIN SELECT RAISE(ABORT,'Dot wake events are append-only.'); END;
    PRAGMA user_version=7;
  `),
    );
  } catch {
    throw new DotRepositoryError('storage-failure');
  }
}

export function migrateDotIntentReviews(db: DatabaseSync): void {
  try {
    transaction(db, () =>
      db.exec(`
    CREATE TABLE dot_intent_reviews (
      intent_id TEXT PRIMARY KEY NOT NULL REFERENCES dot_intents(id),
      dot_id TEXT NOT NULL REFERENCES dots(id),
      run_id TEXT NOT NULL,
      reviewed_at INTEGER NOT NULL CHECK(typeof(reviewed_at)='integer' AND reviewed_at BETWEEN 0 AND 9007199254740991),
      digest TEXT NOT NULL CHECK(length(digest)=64),
      payload TEXT NOT NULL,
      FOREIGN KEY(dot_id,run_id) REFERENCES dot_runs(dot_id,id)
    );
    CREATE TRIGGER dot_review_no_update BEFORE UPDATE ON dot_intent_reviews
      BEGIN SELECT RAISE(ABORT,'Dot uncertainty reviews are immutable.'); END;
    CREATE TRIGGER dot_review_no_delete BEFORE DELETE ON dot_intent_reviews
      BEGIN SELECT RAISE(ABORT,'Dot uncertainty reviews are immutable.'); END;
    PRAGMA user_version=8;
  `),
    );
  } catch {
    throw new DotRepositoryError('storage-failure');
  }
}

export function migrateDotAlerts(db: DatabaseSync): void {
  try {
    transaction(db, () =>
      db.exec(`
    CREATE TABLE dot_alert_claims (
      intent_id TEXT NOT NULL REFERENCES dot_intents(id),
      dot_id TEXT NOT NULL REFERENCES dots(id),
      kind TEXT NOT NULL CHECK(kind IN ('approval','uncertain')),
      intent_revision INTEGER NOT NULL CHECK(typeof(intent_revision)='integer' AND intent_revision BETWEEN 0 AND 9007199254740991),
      intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
      claimed_at INTEGER NOT NULL CHECK(typeof(claimed_at)='integer' AND claimed_at BETWEEN 0 AND 9007199254740991),
      PRIMARY KEY(intent_id,kind)
    );
    CREATE TRIGGER dot_alert_claim_no_update BEFORE UPDATE ON dot_alert_claims
      BEGIN SELECT RAISE(ABORT,'Dot alert attempts are immutable.'); END;
    CREATE TRIGGER dot_alert_claim_no_delete BEFORE DELETE ON dot_alert_claims
      BEGIN SELECT RAISE(ABORT,'Dot alert attempts are immutable.'); END;
    PRAGMA user_version=9;
  `),
    );
  } catch {
    throw new DotRepositoryError('storage-failure');
  }
}
