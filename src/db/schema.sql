-- Every address discovery has heard of, resolved or not. The frontier and the
-- alias map in one table: two addresses that resolve to the same community
-- (a name and its public key) share a public_key.
CREATE TABLE IF NOT EXISTS candidates (
  address          TEXT PRIMARY KEY,   -- as found: a domain or an IPNS key
  first_seen_at    INTEGER NOT NULL,   -- unix seconds
  next_check_at    INTEGER NOT NULL,
  last_checked_at  INTEGER,
  last_resolved_at INTEGER,
  failures         INTEGER NOT NULL DEFAULT 0, -- consecutive failed checks
  last_error       TEXT,
  public_key       TEXT                -- the community it resolved to, once it did
);
CREATE INDEX IF NOT EXISTS idx_candidates_due ON candidates(next_check_at);
CREATE INDEX IF NOT EXISTS idx_candidates_key ON candidates(public_key);

-- Communities that resolved at least once, keyed by their IPNS public key.
-- Metadata only: discovery never stores posts.
CREATE TABLE IF NOT EXISTS communities (
  public_key        TEXT PRIMARY KEY,
  address           TEXT NOT NULL,     -- what the community calls itself: its name, else its key
  name              TEXT,
  title             TEXT,
  description       TEXT,
  created_at        INTEGER,           -- owner-claimed
  updated_at        INTEGER,           -- the record's own updatedAt: the owner's last publish
  pseudonymity_mode TEXT,              -- features.pseudonymityMode
  safe_for_work     INTEGER,           -- features.safeForWork: 1, 0, or NULL when unset
  ui_type           TEXT,              -- suggested.uiType ("author" = a profile)
  first_seen_at     INTEGER NOT NULL,  -- first successful check
  last_resolved_at  INTEGER NOT NULL
);

-- How each address was found. `via` is the source URL, the ENS node, or the
-- community whose content pointed at it, so rows stay bounded by communities,
-- not comments.
CREATE TABLE IF NOT EXISTS sources (
  address       TEXT NOT NULL,
  type          TEXT NOT NULL,
  via           TEXT NOT NULL DEFAULT '',
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (address, type, via)
);

-- `author.previousCommentCid` hops already fetched, so a chain is walked once.
CREATE TABLE IF NOT EXISTS followed_comments (
  cid               TEXT PRIMARY KEY,
  community_address TEXT,
  previous_cid      TEXT,
  fetched_at        INTEGER NOT NULL
);

-- Cursors: the ENS block reached, the newest comment read from each indexer.
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
