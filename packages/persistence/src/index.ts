import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActionJournalPort, SourceRecord } from '@prospero/core';
import {
  createActionJournal,
  readActionPlans,
  recoverActionPlans,
  transaction,
} from './action-journal';
export type { StoredActionPlan } from './action-journal';

export const SOURCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredConversation {
  id: string;
  title: string;
  updatedAt: number;
  state: string;
}
export interface ExecutionRecord {
  id: string;
  conversationId: string;
  state: string;
  startedAt: number;
  finishedAt?: number;
  modelTurns?: number;
  toolCalls?: number;
}

/** SQLite owns durable snapshots and execution summaries; credentials must arrive encrypted. */
export class ProsperoStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 2) {
      this.db.close();
      throw new Error('Database created by a newer Prospero version.');
    }
    if (version === 0)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, state TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, model_turns INTEGER, tool_calls INTEGER);
      PRAGMA user_version = 1;
      COMMIT;
    `);
    if (version < 2)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE action_plans (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared','approved','completed','denied','stale','partial','failed','cancelled','interrupted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE action_journal (
        plan_id TEXT NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','stale','denied','cancelled','skipped','interrupted')),
        at INTEGER NOT NULL,
        detail TEXT,
        PRIMARY KEY(plan_id,sequence)
      );
      CREATE INDEX action_plans_conversation ON action_plans(conversation_id,created_at);
      CREATE INDEX action_journal_latest ON action_journal(plan_id,action_id,sequence);
      CREATE TRIGGER action_plan_immutable BEFORE UPDATE OF id,conversation_id,execution_id,payload,created_at ON action_plans
        BEGIN SELECT RAISE(ABORT,'Action Plan is immutable.'); END;
      CREATE TRIGGER action_journal_no_update BEFORE UPDATE ON action_journal
        BEGIN SELECT RAISE(ABORT,'Action journal is append-only.'); END;
      CREATE TRIGGER action_journal_no_direct_delete BEFORE DELETE ON action_journal
        WHEN EXISTS (SELECT 1 FROM action_plans WHERE id=OLD.plan_id)
        BEGIN SELECT RAISE(ABORT,'Action journal is append-only.'); END;
      CREATE TABLE web_sources (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(conversation_id,id)
      );
      CREATE INDEX web_sources_expiry ON web_sources(expires_at);
      PRAGMA user_version = 2;
      COMMIT;
    `);
    this.db.prepare('DELETE FROM web_sources WHERE expires_at<=?').run(Date.now());
  }
  saveConversation<T extends StoredConversation>(conversation: T): void {
    this.db
      .prepare(
        'INSERT INTO conversations VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, state=excluded.state, payload=excluded.payload',
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.updatedAt,
        conversation.state,
        JSON.stringify(conversation),
      );
  }
  getConversation<T extends StoredConversation>(id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM conversations WHERE id=?').get(id) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  conversations<T extends StoredConversation>(): T[] {
    return this.db
      .prepare('SELECT payload FROM conversations ORDER BY updated_at DESC')
      .all()
      .map((row) => JSON.parse(row.payload as string) as T);
  }
  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
  }
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT payload FROM settings WHERE key=?').get(key) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as T) : fallback;
  }
  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }
  providers<T>(): T[] {
    return this.db
      .prepare('SELECT payload FROM providers')
      .all()
      .map((row) => JSON.parse(row.payload as string) as T);
  }
  saveProvider<T extends { id: string }>(provider: T): void {
    this.db
      .prepare('INSERT OR REPLACE INTO providers VALUES (?, ?)')
      .run(provider.id, JSON.stringify(provider));
  }
  deleteProvider(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM providers WHERE id=?').run(id);
      this.db.prepare('DELETE FROM credentials WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  saveEncryptedCredential(id: string, ciphertext: Uint8Array): void {
    if (ciphertext.byteLength === 0) throw new Error('Encrypted credential is empty.');
    this.db.prepare('INSERT OR REPLACE INTO credentials VALUES (?, ?)').run(id, ciphertext);
  }
  encryptedCredential(id: string): Uint8Array | undefined {
    return (
      this.db.prepare('SELECT ciphertext FROM credentials WHERE id=?').get(id) as
        | { ciphertext: Uint8Array }
        | undefined
    )?.ciphertext;
  }
  deleteCredential(id: string): void {
    this.db.prepare('DELETE FROM credentials WHERE id=?').run(id);
  }
  actionJournal(conversationId: string, executionId: string): ActionJournalPort {
    return createActionJournal(this.db, conversationId, executionId);
  }
  actionPlans(conversationId: string) {
    return readActionPlans(this.db, conversationId);
  }
  recoverActionPlans(): number {
    return recoverActionPlans(this.db);
  }
  /** Web bodies are deliberately excluded; only bounded provenance can reach SQLite. */
  saveSources(
    conversationId: string,
    sources: readonly SourceRecord[],
    retention: 'session' | 'sources' = 'sources',
  ): void {
    if (
      !Array.isArray(sources) ||
      sources.length > 100 ||
      !['session', 'sources'].includes(retention)
    )
      throw new Error('Web source retention request is invalid.');
    const now = Date.now();
    const records = sources.map((source) => {
      let url: URL;
      try {
        url = new URL(source.url);
      } catch {
        throw new Error('Web source URL is invalid.');
      }
      if (
        !source ||
        typeof source.id !== 'string' ||
        !source.id ||
        source.id.length > 300 ||
        source.id.includes('\0') ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        source.url.length > 8192 ||
        typeof source.title !== 'string' ||
        !['search', 'page'].includes(source.kind) ||
        !Number.isSafeInteger(source.retrievedAt) ||
        source.retrievedAt < 0 ||
        typeof source.contentHash !== 'string' ||
        !source.contentHash ||
        source.contentHash.length > 300 ||
        typeof source.excerpt !== 'string'
      )
        throw new Error('Web source provenance is invalid.');
      const record: SourceRecord = {
        id: source.id,
        url: source.url,
        title: source.title.slice(0, 500),
        kind: source.kind,
        retrievedAt: source.retrievedAt,
        contentHash: source.contentHash,
        excerpt: source.excerpt.slice(0, 1200),
      };
      return { record, expiresAt: Math.min(now, source.retrievedAt) + SOURCE_RETENTION_MS };
    });
    if (retention === 'session') return;
    transaction(this.db, () => {
      for (const { record, expiresAt } of records) {
        if (expiresAt <= now) continue;
        const existing = this.db
          .prepare('SELECT payload FROM web_sources WHERE conversation_id=? AND id=?')
          .get(conversationId, record.id) as { payload: string } | undefined;
        if (existing) {
          const prior = JSON.parse(existing.payload) as SourceRecord;
          if (
            prior.url !== record.url ||
            prior.contentHash !== record.contentHash ||
            prior.kind !== record.kind
          )
            throw new Error('Web source identity cannot be reassigned.');
        }
        this.db
          .prepare('INSERT OR REPLACE INTO web_sources VALUES (?,?,?,?)')
          .run(conversationId, record.id, JSON.stringify(record), expiresAt);
      }
    });
  }
  sources(conversationId: string): SourceRecord[] {
    const now = Date.now();
    this.db.prepare('DELETE FROM web_sources WHERE expires_at<=?').run(now);
    return this.db
      .prepare(
        'SELECT payload FROM web_sources WHERE conversation_id=? AND expires_at>? ORDER BY rowid',
      )
      .all(conversationId, now)
      .map((row) => JSON.parse(row.payload as string) as SourceRecord);
  }
  clearSources(conversationId?: string): void {
    if (conversationId === undefined) this.db.prepare('DELETE FROM web_sources').run();
    else this.db.prepare('DELETE FROM web_sources WHERE conversation_id=?').run(conversationId);
  }
  saveExecution(record: ExecutionRecord): void {
    this.db
      .prepare(
        'INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, finished_at=excluded.finished_at, model_turns=excluded.model_turns, tool_calls=excluded.tool_calls',
      )
      .run(
        record.id,
        record.conversationId,
        record.state,
        record.startedAt,
        record.finishedAt ?? null,
        record.modelTurns ?? null,
        record.toolCalls ?? null,
      );
  }
  executions(conversationId: string): ExecutionRecord[] {
    return this.db
      .prepare('SELECT * FROM executions WHERE conversation_id=? ORDER BY started_at')
      .all(conversationId)
      .map((row) => ({
        id: row.id as string,
        conversationId: row.conversation_id as string,
        state: row.state as string,
        startedAt: row.started_at as number,
        finishedAt: row.finished_at as number | undefined,
        modelTurns: row.model_turns as number | undefined,
        toolCalls: row.tool_calls as number | undefined,
      }));
  }
  interruptExecutions(): void {
    this.db
      .prepare(
        "UPDATE executions SET state='interrupted', finished_at=? WHERE state NOT IN ('completed','failed','cancelled','interrupted')",
      )
      .run(Date.now());
  }
  close(): void {
    this.db.close();
  }
}
