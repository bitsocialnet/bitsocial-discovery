/**
 * Operator review file (OVERRIDES_SOURCE): what this instance has decided
 * about each community. Discovery finds communities nobody has looked at, so
 * an operator who publishes the list needs a way to mark what they reviewed,
 * hide what they have not, and stop touching what is illegal.
 *
 * File format — a JSON array of objects keyed by any of a community's
 * addresses (its name, its public key, or an alias it was found under):
 *
 *   [
 *     { "address": "memes.bso", "status": "approved" },
 *     { "address": "12D3KooW…", "status": "listed", "nsfw": true },
 *     { "address": "spam.bso", "status": "hidden", "reason": "spam" },
 *     { "address": "12D3KooW…", "status": "blocked", "reason": "CSAM report 2026-11-02" }
 *   ]
 *
 * - approved: its content was checked (automatically or by a person).
 * - listed:   its title and description were checked; content was not.
 * - hidden:   never shown by the public API, still checked and expanded.
 * - blocked:  never shown, never fetched again, its content never harvested.
 *
 * `nsfw` overrides the community's own `features.safeForWork`. `reason` is an
 * operator note and is only shown to admin requests. The file is re-read
 * whenever its mtime changes (polled every 30s); a broken or unreadable file
 * keeps the previous verdicts, a deleted one clears them, and one that cannot
 * be loaded at startup stops the service from starting.
 */
import { readFile, stat } from 'node:fs/promises';
import { normalizeAddress } from './address.js';
import { config } from './config.js';
import { getState, requeueCandidatesOf, setState } from './db/index.js';
import { errorMessage, nowSec } from './util.js';

export const REVIEW_STATUSES = ['approved', 'listed', 'hidden', 'blocked'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface Override {
  status?: ReviewStatus;
  nsfw?: boolean;
  reason?: string;
}

const POLL_MS = 30_000;

/** Most restrictive first: when two aliases of one community disagree, the stricter verdict wins. */
const PRECEDENCE: ReviewStatus[] = ['blocked', 'hidden', 'listed', 'approved'];

let overrides = new Map<string, Override>();

/** Normalize parsed JSON into per-address overrides; invalid entries are skipped. */
export function parseOverrides(data: unknown): Map<string, Override> {
  if (!Array.isArray(data)) throw new Error('overrides must be a JSON array');
  const out = new Map<string, Override>();
  for (const item of data) {
    const o = item as { address?: unknown; status?: unknown; nsfw?: unknown; reason?: unknown } | null;
    if (!o || typeof o !== 'object' || typeof o.address !== 'string' || !o.address.trim()) {
      console.error('[overrides] skipping invalid entry:', JSON.stringify(item));
      continue;
    }
    const entry: Override = {};
    if (typeof o.status === 'string' && (REVIEW_STATUSES as readonly string[]).includes(o.status)) {
      entry.status = o.status as ReviewStatus;
    } else if (o.status !== undefined) {
      console.error('[overrides] skipping unknown status:', JSON.stringify(item));
      continue;
    }
    if (typeof o.nsfw === 'boolean') entry.nsfw = o.nsfw;
    if (typeof o.reason === 'string') entry.reason = o.reason;
    out.set(normalizeAddress(o.address), entry);
  }
  return out;
}

export function setOverrides(next: Map<string, Override>): void {
  overrides = next;
}

/** The verdicts a name passes on to a record that claims it without proof: only restrictions. */
const CLAIM_STATUSES: readonly ReviewStatus[] = ['blocked', 'hidden'];

/**
 * The combined verdict for one community, given every address it is known by.
 * Status: the most restrictive any alias carries. NSFW: true if any alias says
 * so, false only if one says false and none says true.
 *
 * `claims` are names the community's record claims that are not verified to
 * resolve to it. They only make the verdict stricter (blocked, hidden, NSFW):
 * a record cannot take on the approval of a name it may not own, and cannot
 * escape a block on a name that is never fetched and so never verified.
 */
export function overrideFor(addresses: Iterable<string>, claims: Iterable<string> = []): Override {
  let status: ReviewStatus | undefined;
  let nsfw: boolean | undefined;
  const reasons: string[] = [];
  const apply = (o: Override): void => {
    if (o.status && (!status || PRECEDENCE.indexOf(o.status) < PRECEDENCE.indexOf(status))) status = o.status;
    if (o.nsfw !== undefined) nsfw = nsfw === true || o.nsfw;
    if (o.reason) reasons.push(o.reason);
  };
  for (const address of addresses) {
    const o = overrides.get(normalizeAddress(address));
    if (o) apply(o);
  }
  for (const address of claims) {
    const o = overrides.get(normalizeAddress(address));
    const restricts = o?.status !== undefined && CLAIM_STATUSES.includes(o.status);
    if (!o || (!restricts && o.nsfw !== true)) continue;
    apply({ status: restricts ? o.status : undefined, nsfw: o.nsfw || undefined, reason: o.reason });
  }
  return {
    ...(status ? { status } : {}),
    ...(nsfw !== undefined ? { nsfw } : {}),
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}

let lastMtimeMs: number | null = null; // null = never loaded, -1 = file absent
let timer: NodeJS.Timeout | undefined;

/** The `state` row holding the addresses the last applied verdicts block. */
const APPLIED_BLOCKS_STATE = 'overrides:blocked';

function blockedIn(verdicts: Map<string, Override>): string[] {
  return [...verdicts].filter(([, o]) => o.status === 'blocked').map(([address]) => address);
}

/**
 * Swap in the verdicts of a reloaded file. Discovery pushes a blocked
 * candidate back by RETRY_MAX_MS whenever it comes due, and nothing else
 * brings it forward, so lifting a block makes that community due at once.
 * The blocks applied last are also kept in the database: after a restart the
 * previous verdicts are not in memory, and a block lifted while the service
 * was down has to count as lifted too.
 */
function applyOverrides(next: Map<string, Override>): void {
  const before = new Set(blockedIn(overrides));
  setOverrides(next);
  try {
    const saved = getState(APPLIED_BLOCKS_STATE);
    for (const address of saved ? (JSON.parse(saved) as string[]) : []) before.add(address);
    const lifted = [...before].filter((address) => next.get(address)?.status !== 'blocked');
    if (lifted.length) requeueCandidatesOf(lifted, nowSec());
    setState(APPLIED_BLOCKS_STATE, JSON.stringify(blockedIn(next)));
  } catch (err) {
    console.error(`[overrides] could not re-queue unblocked communities: ${errorMessage(err)}`);
  }
}

/** Check the file's mtime and (re)apply it when it changed. Exported for tests. */
export async function pollOverrides(source = config.overridesSource): Promise<void> {
  if (!source) return;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(source)).mtimeMs;
  } catch (err) {
    // Only a deleted file withdraws the verdicts. Any other failure (permissions, too many open
    // files) says nothing about what the operator decided, so the current verdicts stay.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[overrides] cannot read ${source}: ${errorMessage(err)}`);
      return;
    }
    // Never loaded: nothing to clear, and startOverrides refuses to start, so the blocks the
    // last run applied stay recorded for the run that loads the file.
    if (lastMtimeMs !== null && lastMtimeMs !== -1) {
      console.log(`[overrides] ${source} is gone — overrides cleared`);
      applyOverrides(new Map());
    }
    lastMtimeMs = -1;
    return;
  }
  if (mtimeMs === lastMtimeMs) return;
  try {
    const next = parseOverrides(JSON.parse(await readFile(source, 'utf8')));
    lastMtimeMs = mtimeMs;
    applyOverrides(next);
    console.log(`[overrides] applied ${next.size} entries from ${source}`);
  } catch (err) {
    console.error(`[overrides] failed to load ${source}: ${errorMessage(err)}`);
  }
}

/**
 * Load OVERRIDES_SOURCE before anything is served or fetched. A configured
 * file that cannot be loaded is fatal: running without it would list hidden
 * communities and fetch blocked ones until someone read the log.
 */
export async function startOverrides(): Promise<void> {
  const source = config.overridesSource;
  if (!source) {
    // No review file any more: the blocks an earlier run applied are lifted.
    applyOverrides(new Map());
    return;
  }
  lastMtimeMs = null;
  await pollOverrides(source);
  if (lastMtimeMs === null || lastMtimeMs === -1) {
    throw new Error(`OVERRIDES_SOURCE ${source} could not be loaded; not starting without the review file`);
  }
  timer = setInterval(() => void pollOverrides(), POLL_MS);
  timer.unref();
}

export function stopOverrides(): void {
  if (timer) clearInterval(timer);
}
