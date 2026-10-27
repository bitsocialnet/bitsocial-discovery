/**
 * Community lists: seeds and submissions. The formats are the ones Bitsocial
 * lists already use, so a bitsocialnet/lists file, an indexer's
 * COMMUNITIES_SOURCE file, or a hand-written array all work:
 *
 *   ["a.bso", "12D3KooW…"]
 *   { "communities": [{ "address": "a.bso", "publicKey": "12D3KooW…" }, …] }
 *   { "boards": [ … ] }
 *
 * An entry's `address` and `publicKey` are both kept: a name can stop
 * resolving while its key still works.
 */
import { readFile } from 'node:fs/promises';
import { isAddress, normalizeAddress } from '../address.js';

const FETCH_TIMEOUT_MS = 30_000;

/** A JSON source is either an http(s) URL or a local file path. */
export async function loadJson(source: string): Promise<unknown> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${source} responded ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

/** Every well-formed address in a parsed list, deduplicated. */
export function addressesInList(data: unknown): string[] {
  let entries: unknown[] = [];
  if (Array.isArray(data)) entries = data;
  else {
    const o = data as { communities?: unknown; boards?: unknown } | null;
    for (const list of [o?.communities, o?.boards]) if (Array.isArray(list)) entries = [...entries, ...list];
  }
  const found = new Set<string>();
  for (const entry of entries) {
    const values =
      typeof entry === 'string'
        ? [entry]
        : entry && typeof entry === 'object'
          ? [(entry as { address?: unknown }).address, (entry as { publicKey?: unknown }).publicKey]
          : [];
    for (const value of values) if (typeof value === 'string' && isAddress(value)) found.add(normalizeAddress(value));
  }
  return [...found];
}

export async function loadAddresses(source: string): Promise<string[]> {
  return addressesInList(await loadJson(source));
}
