/**
 * The discovery loop.
 *
 * Sources (seeds, submissions, indexers, ENS) put addresses into `candidates`.
 * Each due candidate is fetched once through the PKC client: a community that
 * resolves has its metadata stored and its record harvested for pointers to
 * more communities (mentions, crossposts, author chains), which become new
 * candidates. Resolved communities are re-checked on an interval, failing
 * ones with exponential backoff, so the set keeps growing as the network
 * links itself together and keeps track of who is still alive.
 *
 * Empty by default: with no seeds, lists, indexers or ENS RPC configured there
 * is nothing to start from and the loop stays idle.
 */
import { isAddress, normalizeAddress } from './address.js';
import { config, hasConfiguredSources } from './config.js';
import {
  addCandidate,
  deferCandidate,
  dueCandidates,
  getFollowedComment,
  getState,
  hasCommunity,
  markFailed,
  markResolved,
  saveFollowedComment,
  setState,
  upsertCommunity,
  type CandidateRow,
  type SourceType,
} from './db/index.js';
import { communityAddressesOf, emptyHarvest, harvestComment, harvestCommunity, type Harvest } from './harvest.js';
import { overrideFor } from './overrides.js';
import { getPkcClient, resetPkcClient, type PkcClient } from './pkc/client.js';
import { scanEns, viemEnsChain, type EnsChain } from './sources/ens.js';
import { indexerCommentsSince, indexerCommunities } from './sources/indexer.js';
import { loadAddresses } from './sources/lists.js';
import { errorMessage, nowSec, runWithConcurrency, TimeoutError, withTimeout } from './util.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TICK_MS = 5_000;
/** Due candidates read per tick, as a multiple of the concurrency. */
const BATCH_FACTOR = 4;
const PKC_RECYCLE_TIMEOUT_MS = 10_000;

/** Seams for tests: the PKC client and the ENS chain. */
export interface Deps {
  pkc: () => Promise<PkcClient>;
  ens: () => EnsChain | null;
}

const defaultDeps: Deps = {
  pkc: getPkcClient,
  ens: () => (config.ethRpcUrl ? viemEnsChain(config.ethRpcUrl) : null),
};

let deps = defaultDeps;

export function setDepsForTest(next: Partial<Deps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

function addAll(addresses: Iterable<string>, type: SourceType, via: string, now: number): number {
  let added = 0;
  for (const address of addresses) if (addCandidate(normalizeAddress(address), type, via, now)) added++;
  return added;
}

/** Exponential backoff after `failures` consecutive failed checks, in seconds. */
export function backoffSeconds(failures: number): number {
  const ms = Math.min(config.retryMaxMs, config.retryMinMs * 2 ** Math.max(0, failures - 1));
  return Math.ceil(ms / 1000);
}

// ── author chains ───────────────────────────────────────────────────────────

/**
 * Walk `author.previousCommentCid` from each start CID, up to the configured
 * depth, and add the community of every comment reached. Each hop is fetched
 * once ever (cached in followed_comments); a hop that fails is retried on the
 * next check. Stops early at `deadline` so a long chain cannot outlive its
 * check's timeout.
 */
export async function followChains(starts: Iterable<string>, via: string, deadline: number): Promise<number> {
  if (config.authorChainDepth === 0) return 0;
  let added = 0;
  let started = 0;
  const visited = new Set<string>();
  for (const start of starts) {
    if (started++ >= config.maxChainsPerCheck) break;
    let cid: string | null = start;
    for (let hop = 0; cid && hop < config.authorChainDepth && !visited.has(cid); hop++) {
      if (Date.now() >= deadline) return added;
      visited.add(cid);
      let hopRow = getFollowedComment(cid);
      if (!hopRow) {
        let comment: any;
        try {
          const pkc = await deps.pkc();
          comment = await withTimeout(pkc.getComment(cid), Math.max(1, deadline - Date.now()), `comment ${cid}`);
        } catch (err) {
          if (err instanceof TimeoutError) void resetPkcClient();
          break;
        }
        const signed = comment?.raw?.comment ?? comment;
        const communities = communityAddressesOf(signed);
        if (!communities.length && typeof comment?.communityAddress === 'string') communities.push(comment.communityAddress);
        const previous = signed?.author?.previousCommentCid ?? comment?.author?.previousCommentCid;
        hopRow = {
          community_address: communities.join(',') || null,
          previous_cid: typeof previous === 'string' ? previous : null,
        };
        saveFollowedComment(cid, hopRow.community_address, hopRow.previous_cid, nowSec());
      }
      if (hopRow.community_address) added += addAll(hopRow.community_address.split(','), 'author-chain', via, nowSec());
      cid = hopRow.previous_cid;
    }
  }
  return added;
}

/** Turn a harvest into candidates credited to the community it came from. */
async function expand(harvest: Harvest, via: string, deadline: number): Promise<number> {
  const now = nowSec();
  let added = addAll(harvest.mentions, 'mention', via, now) + addAll(harvest.crossposts, 'crosspost', via, now);
  added += await followChains(harvest.previousCommentCids, via, deadline);
  return added;
}

// ── checking one candidate ──────────────────────────────────────────────────

function readSafeForWork(community: any): number | null {
  const safeForWork = community?.features?.safeForWork;
  return typeof safeForWork === 'boolean' ? Number(safeForWork) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Fetch one candidate and record what it is. Blocked communities are never
 * fetched again once known, and are never harvested.
 */
export async function checkCandidate(row: CandidateRow): Promise<void> {
  const { address } = row;
  const now = nowSec();
  const known = [address, ...(row.public_key ? [row.public_key] : [])];
  if (overrideFor(known).status === 'blocked') {
    deferCandidate(address, now + Math.ceil(config.retryMaxMs / 1000));
    return;
  }

  const deadline = Date.now() + config.checkTimeoutMs;
  let community: any;
  try {
    const pkc = await deps.pkc();
    community = await withTimeout(pkc.getCommunity(address), config.checkTimeoutMs, `community ${address}`);
  } catch (err) {
    if (err instanceof TimeoutError) void resetPkcClient();
    const failures = markFailed(address, errorMessage(err), now, now + backoffSeconds((row.failures ?? 0) + 1));
    if (failures === 1) console.log(`[discover] ${address}: ${errorMessage(err)}`);
    return;
  }

  // pkc-js derives publicKey from the record's signature; a key-shaped address is the only fallback.
  const publicKey = str(community?.publicKey) ?? (isAddress(address) && !/\.(?:bso|eth)$/.test(address) ? address : null);
  if (!publicKey) {
    markFailed(address, 'community has no public key', now, now + backoffSeconds((row.failures ?? 0) + 1));
    return;
  }
  // A record can claim any name; only one that resolves back to this key is its address.
  const name = community?.nameResolved === false ? null : str(community?.name);
  const isNew = !hasCommunity(publicKey);
  upsertCommunity({
    public_key: publicKey,
    address: name ? normalizeAddress(name) : publicKey,
    name: name ? normalizeAddress(name) : null,
    title: str(community?.title),
    description: str(community?.description),
    created_at: num(community?.createdAt),
    updated_at: num(community?.updatedAt),
    pseudonymity_mode: str(community?.features?.pseudonymityMode),
    safe_for_work: readSafeForWork(community),
    ui_type: str(community?.suggested?.uiType),
    last_resolved_at: now,
  });
  markResolved(address, publicKey, now, now + Math.ceil(config.recheckIntervalMs / 1000));
  if (isNew) console.log(`[discover] resolved ${address}${name && name !== address ? ` (${name})` : ''}`);

  if (overrideFor([...known, publicKey, ...(name ? [name] : [])]).status === 'blocked') return;
  const added = await expand(harvestCommunity(community), name ?? publicKey, deadline);
  if (added) console.log(`[discover] ${name ?? address}: ${added} new candidates`);
}

// ── sources ─────────────────────────────────────────────────────────────────

async function readList(source: string, type: SourceType): Promise<void> {
  try {
    const added = addAll(await loadAddresses(source), type, source, nowSec());
    if (added) console.log(`[sources] ${source}: ${added} new candidates`);
  } catch (err) {
    console.error(`[sources] ${source}: ${errorMessage(err)}`);
  }
}

async function readIndexer(baseUrl: string): Promise<void> {
  try {
    let added = addAll(await indexerCommunities(baseUrl), 'indexer', baseUrl, nowSec());
    const key = `indexer:${baseUrl}:cursor`;
    const { comments, cursor } = await indexerCommentsSince(baseUrl, Number(getState(key) ?? 0), nowSec());
    // Credit pointers to the community each comment was posted in.
    const byCommunity = new Map<string, Harvest>();
    for (const c of comments) {
      const harvest = byCommunity.get(c.community_address) ?? emptyHarvest();
      harvestComment(c, harvest);
      byCommunity.set(c.community_address, harvest);
    }
    const deadline = Date.now() + config.checkTimeoutMs;
    for (const [community, harvest] of byCommunity) added += await expand(harvest, community, deadline);
    setState(key, String(cursor));
    if (added) console.log(`[sources] ${baseUrl}: ${added} new candidates from ${comments.length} comments`);
  } catch (err) {
    console.error(`[sources] ${baseUrl}: ${errorMessage(err)}`);
  }
}

async function readEns(): Promise<void> {
  const chain = deps.ens();
  if (!chain) return;
  try {
    const saved = getState('ens:cursor');
    await scanEns({
      chain,
      fromBlock: config.ensFromBlock,
      maxRange: BigInt(config.ensMaxBlockRange),
      cursor: saved === undefined ? undefined : BigInt(saved),
      saveCursor: (block) => setState('ens:cursor', block.toString()),
      onRecord: ({ node, publicKey }) => addCandidate(publicKey, 'ens', node, nowSec()),
      log: (message) => console.log(message),
    });
  } catch (err) {
    console.error(`[ens] ${errorMessage(err)}`);
  }
}

let refreshing = false;
let lastRefreshAt: number | null = null;

/** Read every configured source once. One failing source never blocks the others. */
export async function refreshSources(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    addAll(config.seeds, 'seed', 'SEEDS', nowSec());
    for (const source of config.seedsSources) await readList(source, 'seed');
    if (config.submissionsSource) await readList(config.submissionsSource, 'submission');
    for (const url of config.indexerUrls) await readIndexer(url);
    await readEns();
    lastRefreshAt = nowSec();
  } finally {
    refreshing = false;
  }
}

export function lastSourcesRefreshAt(): number | null {
  return lastRefreshAt;
}

// ── the loop ────────────────────────────────────────────────────────────────

let ticking = false;

/**
 * pkc-js keeps every community and comment it loaded until the client is
 * destroyed (see bitsocial-indexer's crawler), so a tick that used the client
 * retires it and the next one reconnects.
 */
async function recyclePkcClient(): Promise<void> {
  try {
    await withTimeout(resetPkcClient({ quiet: true }), PKC_RECYCLE_TIMEOUT_MS, 'PKC client recycle');
  } catch (err) {
    console.error(`[discover] ${errorMessage(err)}`);
  }
}

/** Check every due candidate, a batch at a time. Returns how many were checked. */
export async function tick(): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let checked = 0;
  try {
    const due = dueCandidates(nowSec(), config.checkConcurrency * BATCH_FACTOR);
    await runWithConcurrency(due, config.checkConcurrency, async (row) => {
      checked++;
      try {
        await checkCandidate(row);
      } catch (err) {
        // A bug in one check must not stop the loop; push the row back so it cannot spin.
        console.error(`[discover] ${row.address}: ${errorMessage(err)}`);
        deferCandidate(row.address, nowSec() + backoffSeconds((row.failures ?? 0) + 1));
      }
    });
  } finally {
    if (checked && deps.pkc === defaultDeps.pkc) await recyclePkcClient();
    ticking = false;
  }
  return checked;
}

let tickTimer: NodeJS.Timeout | undefined;
let sourcesTimer: NodeJS.Timeout | undefined;

export async function startDiscovery(): Promise<void> {
  if (!hasConfiguredSources()) {
    console.log('[discover] idle — nothing to start from (SEEDS, SEEDS_SOURCES, SUBMISSIONS_SOURCE, INDEXER_URLS, ETH_RPC_URL all empty).');
    return;
  }
  await refreshSources();
  sourcesTimer = setInterval(() => void refreshSources(), config.sourcesRefreshMs);
  tickTimer = setInterval(() => void tick(), TICK_MS);
  void tick();
}

export function stopDiscovery(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (sourcesTimer) clearInterval(sourcesTimer);
}

/* eslint-enable @typescript-eslint/no-explicit-any */
