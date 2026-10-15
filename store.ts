import type Database from "better-sqlite3";

// The host keys migrations by statement index; shipped statements stay in place.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS queue_annotations (
    thread_id TEXT PRIMARY KEY,
    summary_markdown TEXT,
    idle_disposition TEXT CHECK (idle_disposition IN ('needs_response', 'done')),
    reviewed_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_through_seq >= 0),
    user_managed INTEGER NOT NULL DEFAULT 0 CHECK (user_managed IN (0, 1)),
    summary_updated_at INTEGER,
    disposition_updated_at INTEGER,
    mode_updated_at INTEGER
  )`,
  "UPDATE queue_annotations SET user_managed = 0, mode_updated_at = NULL",
  "DROP TABLE IF EXISTS queue_annotations",
  `CREATE TABLE feed_cards (
    thread_id TEXT PRIMARY KEY,
    one_line TEXT NOT NULL,
    summary_markdown TEXT NOT NULL,
    result_seq INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE feed_marks (
    thread_id TEXT PRIMARY KEY,
    result_seq INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE feed_pauses (
    thread_id TEXT PRIMARY KEY,
    paused_at INTEGER NOT NULL
  )`,
  `CREATE TABLE summarizer_jobs (
    thread_id TEXT PRIMARY KEY,
    result_seq INTEGER NOT NULL,
    enqueued_at INTEGER NOT NULL
  )`,
  `CREATE TABLE feed_results (
    thread_id TEXT PRIMARY KEY,
    last_job_seq INTEGER NOT NULL
  )`,
  `CREATE TABLE summarizer_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  "DROP TABLE IF EXISTS summarizer_jobs",
  "DROP TABLE IF EXISTS feed_results",
  "DROP TABLE IF EXISTS summarizer_state",
  "DROP TABLE IF EXISTS feed_cards",
  `CREATE TABLE feed_summaries (
    thread_id TEXT PRIMARY KEY,
    one_line TEXT,
    result_seq INTEGER NOT NULL DEFAULT 0,
    failed_seq INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
];

/** The summarizer thread ID that an earlier version stored, read before the migrations drop its table. */
export function readRetiredSummarizerId(db: Database.Database): string | null {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'summarizer_state'")
    .get();
  if (table === undefined) return null;
  const row = db
    .prepare("SELECT value FROM summarizer_state WHERE key = 'threadId'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

/** R20: the one-line summary records the result it describes; `failedSeq` is the result whose call failed. */
export interface FeedSummary {
  oneLine: string | null;
  resultSeq: number;
  failedSeq: number;
}

interface SummaryRow {
  one_line: string | null;
  result_seq: number;
  failed_seq: number;
}

export class FeedStore {
  constructor(private readonly db: Database.Database) {}

  getSummary(threadId: string): FeedSummary | null {
    const row = this.db
      .prepare("SELECT one_line, result_seq, failed_seq FROM feed_summaries WHERE thread_id = ?")
      .get(threadId) as SummaryRow | undefined;
    return row === undefined
      ? null
      : { oneLine: row.one_line, resultSeq: row.result_seq, failedSeq: row.failed_seq };
  }

  listSummaries(threadIds: readonly string[]): Map<string, FeedSummary> {
    const result = new Map<string, FeedSummary>();
    for (const threadId of threadIds) {
      const summary = this.getSummary(threadId);
      if (summary !== null) result.set(threadId, summary);
    }
    return result;
  }

  /** Writes a line only for a result newer than the stored one. */
  writeSummary(threadId: string, oneLine: string, resultSeq: number): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO feed_summaries (thread_id, one_line, result_seq, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           one_line = excluded.one_line,
           result_seq = excluded.result_seq,
           updated_at = excluded.updated_at
         WHERE excluded.result_seq > feed_summaries.result_seq`,
      )
      .run(threadId, oneLine, resultSeq, Date.now());
    return result.changes > 0;
  }

  writeFailure(threadId: string, resultSeq: number): void {
    this.db
      .prepare(
        `INSERT INTO feed_summaries (thread_id, failed_seq, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           failed_seq = max(feed_summaries.failed_seq, excluded.failed_seq),
           updated_at = excluded.updated_at`,
      )
      .run(threadId, resultSeq, Date.now());
  }

  getMark(threadId: string): number | null {
    const row = this.db
      .prepare("SELECT result_seq FROM feed_marks WHERE thread_id = ?")
      .get(threadId) as { result_seq: number } | undefined;
    return row?.result_seq ?? null;
  }

  listMarks(threadIds: readonly string[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const threadId of threadIds) {
      const seq = this.getMark(threadId);
      if (seq !== null) result.set(threadId, seq);
    }
    return result;
  }

  writeMark(threadId: string, resultSeq: number): void {
    this.db
      .prepare(
        `INSERT INTO feed_marks (thread_id, result_seq, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           result_seq = excluded.result_seq,
           updated_at = excluded.updated_at`,
      )
      .run(threadId, resultSeq, Date.now());
  }

  setPaused(threadId: string, paused: boolean): void {
    if (paused) {
      this.db
        .prepare(
          "INSERT INTO feed_pauses (thread_id, paused_at) VALUES (?, ?) ON CONFLICT(thread_id) DO NOTHING",
        )
        .run(threadId, Date.now());
    } else {
      this.db.prepare("DELETE FROM feed_pauses WHERE thread_id = ?").run(threadId);
    }
  }

  getPausedAt(threadId: string): number | null {
    const row = this.db
      .prepare("SELECT paused_at FROM feed_pauses WHERE thread_id = ?")
      .get(threadId) as { paused_at: number } | undefined;
    return row?.paused_at ?? null;
  }

  listPaused(threadIds: readonly string[]): Set<string> {
    const get = this.db.prepare("SELECT 1 FROM feed_pauses WHERE thread_id = ?");
    return new Set(threadIds.filter((threadId) => get.get(threadId) !== undefined));
  }
}
