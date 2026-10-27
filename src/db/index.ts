import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/** How an address was found. */
export type SourceType =
  | 'seed'
  | 'submission'
  | 'indexer'
  | 'ens'
  | 'author-chain'
  | 'crosspost'
  | 'mention';

export interface CandidateRow {
  address: string;
  first_seen_at: number;
  next_check_at: number;
  last_checked_at: number | null;
  last_resolved_at: number | null;
  failures: number;
  last_error: string | null;
  public_key: string | null;
}

export interface CommunityRow {
  public_key: string;
  address: string;
  name: string | null;
  title: string | null;
  description: string | null;
  created_at: number | null;
  updated_at: number | null;
  pseudonymity_mode: string | null;
  safe_for_work: number | null;
  ui_type: string | null;
  first_seen_at: number;
  last_resolved_at: number;
}

export interface SourceRow {
  address: string;
  type: SourceType;
  via: string;
  first_seen_at: number;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const here = dirname(fileURLToPath(import.meta.url));
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

/** Drop the connection so the next getDb() starts from an empty in-memory database. Tests only. */
export function resetDbForTest(): void {
  db?.close();
  db = null;
}

/**
 * Remember an address and how it was found. A new address is due at once; a
 * known one only gains the extra source. Returns true when the address is new.
 */
export function addCandidate(address: string, type: SourceType, via: string, now: number): boolean {
  const database = getDb();
  const inserted = database
    .prepare('INSERT OR IGNORE INTO candidates (address, first_seen_at, next_check_at) VALUES (?, ?, ?)')
    .run(address, now, now).changes > 0;
  database
    .prepare('INSERT OR IGNORE INTO sources (address, type, via, first_seen_at) VALUES (?, ?, ?, ?)')
    .run(address, type, via, now);
  return inserted;
}

/** `via` of addresses sent to POST /api/submissions, as opposed to a SUBMISSIONS_SOURCE file. */
export const API_SUBMISSION_VIA = 'api';

const HOUR_SECONDS = 3600;

export type SubmissionResult = { accepted: true } | { accepted: false; retryAfter: number };

/**
 * Record an address sent to POST /api/submissions, unless the last hour
 * already took `perHour` new ones. Resubmitting an address is accepted without
 * using the allowance.
 */
export function recordSubmission(address: string, now: number, perHour: number): SubmissionResult {
  const database = getDb();
  return database.transaction((): SubmissionResult => {
    const known = database
      .prepare("SELECT 1 FROM sources WHERE address = ? AND type = 'submission' AND via = ?")
      .get(address, API_SUBMISSION_VIA);
    if (known) return { accepted: true };
    const recent = database
      .prepare(
        `SELECT COUNT(*) AS n, MIN(first_seen_at) AS oldest FROM sources
           WHERE type = 'submission' AND via = ? AND first_seen_at > ?`,
      )
      .get(API_SUBMISSION_VIA, now - HOUR_SECONDS) as { n: number; oldest: number | null };
    if (recent.n >= perHour) {
      return { accepted: false, retryAfter: Math.max(1, (recent.oldest ?? now) + HOUR_SECONDS - now) };
    }
    addCandidate(address, 'submission', API_SUBMISSION_VIA, now);
    return { accepted: true };
  })();
}

/**
 * Forget an address that never resolved and that only POST /api/submissions
 * ever pointed at, so what strangers submit cannot pile up and be rechecked
 * forever. Returns true when it was dropped.
 */
export function dropUnresolvedSubmission(address: string): boolean {
  const database = getDb();
  return database.transaction((): boolean => {
    const { fromApi, total } = database
      .prepare(
        `SELECT COALESCE(SUM(type = 'submission' AND via = ?), 0) AS fromApi, COUNT(*) AS total
           FROM sources WHERE address = ?`,
      )
      .get(API_SUBMISSION_VIA, address) as { fromApi: number; total: number };
    if (total === 0 || fromApi !== total || getCandidate(address)?.last_resolved_at !== null) return false;
    database.prepare('DELETE FROM sources WHERE address = ?').run(address);
    database.prepare('DELETE FROM candidates WHERE address = ?').run(address);
    return true;
  })();
}

export function getCandidate(address: string): CandidateRow | undefined {
  return getDb().prepare('SELECT * FROM candidates WHERE address = ?').get(address) as CandidateRow | undefined;
}

export function dueCandidates(now: number, limit: number): CandidateRow[] {
  return getDb()
    .prepare('SELECT * FROM candidates WHERE next_check_at <= ? ORDER BY next_check_at, address LIMIT ?')
    .all(now, limit) as CandidateRow[];
}

export function markResolved(address: string, publicKey: string, now: number, nextCheckAt: number): void {
  getDb()
    .prepare(
      `UPDATE candidates SET public_key = ?, last_checked_at = ?, last_resolved_at = ?,
         failures = 0, last_error = NULL, next_check_at = ? WHERE address = ?`,
    )
    .run(publicKey, now, now, nextCheckAt, address);
}

/** Record a failed check. Returns the new consecutive failure count. */
export function markFailed(address: string, error: string, now: number, nextCheckAt: number): number {
  const row = getDb()
    .prepare(
      `UPDATE candidates SET failures = failures + 1, last_error = ?, last_checked_at = ?, next_check_at = ?
         WHERE address = ? RETURNING failures`,
    )
    .get(error.slice(0, 500), now, nextCheckAt, address) as { failures: number } | undefined;
  return row?.failures ?? 0;
}

export function deferCandidate(address: string, nextCheckAt: number): void {
  getDb().prepare('UPDATE candidates SET next_check_at = ? WHERE address = ?').run(nextCheckAt, address);
}

export function upsertCommunity(row: Omit<CommunityRow, 'first_seen_at'>): void {
  getDb()
    .prepare(
      `INSERT INTO communities (public_key, address, name, title, description, created_at, updated_at,
         pseudonymity_mode, safe_for_work, ui_type, first_seen_at, last_resolved_at)
       VALUES (@public_key, @address, @name, @title, @description, @created_at, @updated_at,
         @pseudonymity_mode, @safe_for_work, @ui_type, @last_resolved_at, @last_resolved_at)
       ON CONFLICT(public_key) DO UPDATE SET
         address = excluded.address, name = excluded.name, title = excluded.title,
         description = excluded.description, created_at = excluded.created_at,
         updated_at = excluded.updated_at, pseudonymity_mode = excluded.pseudonymity_mode,
         safe_for_work = excluded.safe_for_work, ui_type = excluded.ui_type,
         last_resolved_at = excluded.last_resolved_at`,
    )
    .run(row);
}

export function hasCommunity(publicKey: string): boolean {
  return getDb().prepare('SELECT 1 FROM communities WHERE public_key = ?').get(publicKey) !== undefined;
}

export function getFollowedComment(cid: string): { community_address: string | null; previous_cid: string | null } | undefined {
  return getDb()
    .prepare('SELECT community_address, previous_cid FROM followed_comments WHERE cid = ?')
    .get(cid) as { community_address: string | null; previous_cid: string | null } | undefined;
}

export function saveFollowedComment(cid: string, communityAddress: string | null, previousCid: string | null, now: number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO followed_comments (cid, community_address, previous_cid, fetched_at) VALUES (?, ?, ?, ?)')
    .run(cid, communityAddress, previousCid, now);
}

export function getState(key: string): string | undefined {
  return (getDb().prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setState(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(key, value);
}

export function allCommunities(): CommunityRow[] {
  return getDb().prepare('SELECT * FROM communities').all() as CommunityRow[];
}

export function allCandidates(): CandidateRow[] {
  return getDb().prepare('SELECT * FROM candidates ORDER BY first_seen_at DESC, address').all() as CandidateRow[];
}

/** Every candidate address that resolved to each public key. */
export function aliasesByKey(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = getDb()
    .prepare('SELECT address, public_key FROM candidates WHERE public_key IS NOT NULL ORDER BY address')
    .all() as { address: string; public_key: string }[];
  for (const { address, public_key } of rows) out.set(public_key, [...(out.get(public_key) ?? []), address]);
  return out;
}

export function sourcesByAddress(): Map<string, SourceRow[]> {
  const out = new Map<string, SourceRow[]>();
  const rows = getDb().prepare('SELECT * FROM sources ORDER BY first_seen_at, type, via').all() as SourceRow[];
  for (const row of rows) out.set(row.address, [...(out.get(row.address) ?? []), row]);
  return out;
}

export function counts(): { candidates: number; communities: number; due: number } {
  const database = getDb();
  const n = (sql: string, ...params: unknown[]) => (database.prepare(sql).get(...params) as { n: number }).n;
  return {
    candidates: n('SELECT COUNT(*) AS n FROM candidates'),
    communities: n('SELECT COUNT(*) AS n FROM communities'),
    due: n('SELECT COUNT(*) AS n FROM candidates WHERE next_check_at <= ?', Math.floor(Date.now() / 1000)),
  };
}
