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
 * whenever its mtime changes (polled every 30s); a broken file keeps the
 * previous verdicts.
 */
import { readFile, stat } from 'node:fs/promises';
import { normalizeAddress } from './address.js';
import { config } from './config.js';
import { errorMessage } from './util.js';

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

/**
 * The combined verdict for one community, given every address it is known by.
 * Status: the most restrictive any alias carries. NSFW: true if any alias says
 * so, false only if one says false and none says true.
 */
export function overrideFor(addresses: Iterable<string>): Override {
  let status: ReviewStatus | undefined;
  let nsfw: boolean | undefined;
  const reasons: string[] = [];
  for (const address of addresses) {
    const o = overrides.get(normalizeAddress(address));
    if (!o) continue;
    if (o.status && (!status || PRECEDENCE.indexOf(o.status) < PRECEDENCE.indexOf(status))) status = o.status;
    if (o.nsfw !== undefined) nsfw = nsfw === true || o.nsfw;
    if (o.reason) reasons.push(o.reason);
  }
  return {
    ...(status ? { status } : {}),
    ...(nsfw !== undefined ? { nsfw } : {}),
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}

let lastMtimeMs: number | null = null; // null = never checked, -1 = file absent
let timer: NodeJS.Timeout | undefined;

/** Check the file's mtime and (re)apply it when it changed. Exported for tests. */
export async function pollOverrides(source = config.overridesSource): Promise<void> {
  if (!source) return;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(source)).mtimeMs;
  } catch {
    if (lastMtimeMs !== -1) {
      if (lastMtimeMs !== null) console.log(`[overrides] ${source} is gone — overrides cleared`);
      lastMtimeMs = -1;
      setOverrides(new Map());
    }
    return;
  }
  if (mtimeMs === lastMtimeMs) return;
  try {
    const next = parseOverrides(JSON.parse(await readFile(source, 'utf8')));
    lastMtimeMs = mtimeMs;
    setOverrides(next);
    console.log(`[overrides] applied ${next.size} entries from ${source}`);
  } catch (err) {
    console.error(`[overrides] failed to load ${source}: ${errorMessage(err)}`);
  }
}

export async function startOverrides(): Promise<void> {
  if (!config.overridesSource) return;
  await pollOverrides();
  timer = setInterval(() => void pollOverrides(), POLL_MS);
  timer.unref();
}

export function stopOverrides(): void {
  if (timer) clearInterval(timer);
}
