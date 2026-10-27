import { join } from 'node:path';

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function positiveDuration(value: string | undefined, fallback: number, name: string): number {
  const duration = Number(value ?? fallback);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${name} must be a finite positive number of milliseconds`);
  }
  return duration;
}

export function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export type PublicListing = 'all' | 'reviewed';

function publicListing(value: string | undefined): PublicListing {
  const v = value ?? 'all';
  if (v !== 'all' && v !== 'reviewed') throw new Error('PUBLIC_LISTING must be "all" or "reviewed"');
  return v;
}

const HOUR = 60 * 60 * 1000;

/** Runtime configuration, all sourced from environment variables. */
export const config = {
  port: Number(process.env.PORT ?? 4100),
  /** Loopback by default: the API lists communities nobody has reviewed yet. */
  host: process.env.HOST ?? '127.0.0.1',

  /** SQLite file path, or ":memory:" for an ephemeral run. */
  dbPath: process.env.DB_PATH ?? join(process.cwd(), 'data', 'discovery.db'),

  /**
   * bitsocial-cli daemon RPC endpoint (PKC over WebSocket). Every community
   * discovery checks is fetched through this node, so point it at a node that
   * does not serve what it fetches (see README, "Fetch-only node").
   */
  pkcRpcUrl: process.env.PKC_RPC_URL ?? 'ws://localhost:9138',

  // ── where discovery starts ────────────────────────────────────────────────
  // All empty by default → discovery has nothing to start from and stays idle.

  /** Comma-separated community addresses to start from. */
  seeds: list(process.env.SEEDS),
  /** Comma-separated URLs/paths of JSON community lists to start from. */
  seedsSources: list(process.env.SEEDS_SOURCES),
  /** URL/path of a JSON list of operator- or user-submitted addresses. */
  submissionsSource: process.env.SUBMISSIONS_SOURCE ?? '',
  /** Comma-separated bitsocial-indexer API base URLs to read communities and comments from. */
  indexerUrls: list(process.env.INDEXER_URLS),
  /** Ethereum JSON-RPC URL for scanning ENS `bitsocial` text records. Empty = no ENS scan. */
  ethRpcUrl: process.env.ETH_RPC_URL ?? '',
  /** First block the ENS scan reads. The default predates every `bitsocial` record. */
  ensFromBlock: BigInt(process.env.ENS_FROM_BLOCK ?? 23_085_558),
  /** Largest eth_getLogs block span; shrinks on its own when a provider refuses it. */
  ensMaxBlockRange: nonNegativeInt(process.env.ENS_MAX_BLOCK_RANGE, 50_000, 'ENS_MAX_BLOCK_RANGE') || 50_000,

  /** How often seeds, submissions, indexers and ENS are read again. */
  sourcesRefreshMs: positiveDuration(process.env.SOURCES_REFRESH_MS, HOUR, 'SOURCES_REFRESH_MS'),

  // ── checking candidates ───────────────────────────────────────────────────

  /** Maximum communities fetched at once. */
  checkConcurrency: nonNegativeInt(process.env.CHECK_CONCURRENCY, 2, 'CHECK_CONCURRENCY') || 1,
  /** Hard cap on one community check, author-chain hops included. */
  checkTimeoutMs: positiveDuration(process.env.CHECK_TIMEOUT_MS, 120_000, 'CHECK_TIMEOUT_MS'),
  /** How long a resolved community waits before it is checked again. */
  recheckIntervalMs: positiveDuration(process.env.RECHECK_INTERVAL_MS, 6 * HOUR, 'RECHECK_INTERVAL_MS'),
  /** Backoff after a failed check: doubles from the minimum up to the maximum. */
  retryMinMs: positiveDuration(process.env.RETRY_MIN_MS, 15 * 60 * 1000, 'RETRY_MIN_MS'),
  retryMaxMs: positiveDuration(process.env.RETRY_MAX_MS, 7 * 24 * HOUR, 'RETRY_MAX_MS'),
  /** How many `author.previousCommentCid` hops to follow from each comment. 0 = off. */
  authorChainDepth: nonNegativeInt(process.env.AUTHOR_CHAIN_DEPTH, 3, 'AUTHOR_CHAIN_DEPTH'),
  /** Most chain starts followed per community check, so one busy community cannot stall the loop. */
  maxChainsPerCheck: nonNegativeInt(process.env.MAX_CHAINS_PER_CHECK, 50, 'MAX_CHAINS_PER_CHECK'),

  // ── what the API shows ────────────────────────────────────────────────────

  /**
   * Operator review file: per-address status (approved / listed / hidden /
   * blocked) and NSFW verdicts. Re-read whenever it changes. See src/overrides.ts.
   */
  overridesSource: process.env.OVERRIDES_SOURCE ?? '',
  /**
   * "all": every resolved community that is not hidden or blocked, with its
   * review status. "reviewed": only communities the overrides file marks
   * approved or listed.
   */
  publicListing: publicListing(process.env.PUBLIC_LISTING),
  /** Bearer token that sees everything: unreviewed, hidden, blocked, failing candidates. */
  adminToken: process.env.ADMIN_TOKEN ?? '',

  /** CORS allow-list, comma-separated ("*" = any origin). */
  allowedOrigins: process.env.ALLOWED_ORIGINS ?? '*',
} as const;

/** True when the operator configured anything for discovery to start from. */
export function hasConfiguredSources(): boolean {
  return (
    config.seeds.length > 0 ||
    config.seedsSources.length > 0 ||
    config.submissionsSource.length > 0 ||
    config.indexerUrls.length > 0 ||
    config.ethRpcUrl.length > 0
  );
}
