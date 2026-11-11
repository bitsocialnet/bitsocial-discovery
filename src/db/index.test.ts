import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { communityViews } from '../api/view.js';
import { config } from '../config.js';
import { parseOverrides, setOverrides } from '../overrides.js';
import { allCommunities, getCandidate, getDb, resetDbForTest, upsertCommunity } from './index.js';

const mutableConfig = config as unknown as Record<string, unknown>;

const FAR = 9_999_999_999;

test('a database created before communities.claimed_name gains the column, and a name nothing verified moves to it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-db-'));
  const path = join(dir, 'discovery.db');
  // The tables as earlier versions created them. They stored any name a record claimed as its
  // address, unless pkc-js said outright that it did not resolve to the record's key.
  const old = new Database(path);
  old.exec(`CREATE TABLE candidates (
    address TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, next_check_at INTEGER NOT NULL, last_checked_at INTEGER,
    last_resolved_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, public_key TEXT)`);
  old.exec(`CREATE TABLE communities (
    public_key TEXT PRIMARY KEY, address TEXT NOT NULL, name TEXT, title TEXT, description TEXT,
    created_at INTEGER, updated_at INTEGER, pseudonymity_mode TEXT, safe_for_work INTEGER, ui_type TEXT,
    first_seen_at INTEGER NOT NULL, last_resolved_at INTEGER NOT NULL)`);
  const community = old.prepare(
    'INSERT INTO communities (public_key, address, name, title, first_seen_at, last_resolved_at) VALUES (?, ?, ?, ?, 1, 1)',
  );
  const candidate = old.prepare('INSERT INTO candidates (address, first_seen_at, next_check_at, public_key) VALUES (?, 1, ?, ?)');
  // memes.bso was fetched under its name and resolved to real-key: that name is verified.
  community.run('real-key', 'memes.bso', 'memes.bso', 'Memes');
  candidate.run('memes.bso', FAR, 'real-key');
  // spoof-key was only ever fetched under its key, and its record claims memes.bso too.
  community.run('spoof-key', 'memes.bso', 'memes.bso', 'fake');
  candidate.run('spoof-key', FAR, 'spoof-key');
  community.run('bare-key', 'bare-key', null, 'Bare');
  candidate.run('bare-key', FAR, 'bare-key');
  old.close();

  const savedPath = config.dbPath;
  mutableConfig.dbPath = path;
  setOverrides(parseOverrides([{ address: 'memes.bso', status: 'approved' }]));
  try {
    resetDbForTest();
    getDb();
    const stored = () =>
      Object.fromEntries(allCommunities().map((row) => [row.public_key, [row.address, row.name, row.claimed_name]]));
    assert.deepEqual(stored(), {
      'real-key': ['memes.bso', 'memes.bso', null],
      'spoof-key': ['spoof-key', null, 'memes.bso'],
      'bare-key': ['bare-key', null, null],
    });
    // The demoted community no longer carries memes.bso's approval, even if it never resolves again.
    const reviews = Object.fromEntries(communityViews(true).map((c) => [c.publicKey, [c.address, c.review]]));
    assert.deepEqual(reviews['spoof-key'], ['spoof-key', 'unreviewed']);
    assert.deepEqual(reviews['real-key'], ['memes.bso', 'approved']);
    // It is checked again at once, so a name it does own is verified and restored soon.
    assert.ok(getCandidate('spoof-key')!.next_check_at < FAR);
    assert.equal(getCandidate('memes.bso')!.next_check_at, FAR);
    assert.equal(getCandidate('bare-key')!.next_check_at, FAR);

    // A name pkc-js verified is stored without a candidate behind it. Opening the database again
    // finds the column already there and leaves every row alone.
    upsertCommunity({
      public_key: 'checked-key',
      address: 'checked.bso',
      name: 'checked.bso',
      claimed_name: null,
      title: null,
      description: null,
      created_at: null,
      updated_at: null,
      pseudonymity_mode: null,
      safe_for_work: null,
      ui_type: null,
      last_resolved_at: 2,
    });
    resetDbForTest();
    assert.deepEqual(stored()['checked-key'], ['checked.bso', 'checked.bso', null]);
    assert.deepEqual(stored()['spoof-key'], ['spoof-key', null, 'memes.bso']);
  } finally {
    resetDbForTest();
    setOverrides(new Map());
    mutableConfig.dbPath = savedPath;
    await rm(dir, { recursive: true, force: true });
  }
});
