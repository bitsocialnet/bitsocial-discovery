/**
 * Pull pointers to other communities out of data discovery already has: a
 * community record (its description, rules and preloaded post pages) or an
 * indexed comment. Pure functions over pkc-js shapes; nothing here fetches.
 *
 * Three kinds of pointer, each a different source type downstream:
 * - mentions: addresses written in titles, bodies, links and descriptions;
 * - crossposts: the community of a crossposted original (embedded, signed);
 * - author chains: `author.previousCommentCid`, which the caller may follow.
 *   Pseudonymous communities strip it, so it only appears on linkable authors.
 */
import { addressesInText, isAddress, normalizeAddress } from './address.js';

export interface Harvest {
  mentions: Set<string>;
  crossposts: Set<string>;
  previousCommentCids: Set<string>;
}

export function emptyHarvest(): Harvest {
  return { mentions: new Set(), crossposts: new Set(), previousCommentCids: new Set() };
}

const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

/** Crossposts nest a full CommentIpfs per level; bound it against hostile records. */
const MAX_CROSSPOST_DEPTH = 8;
/** Preloaded reply pages can nest; the bound only matters for malformed data. */
const MAX_REPLY_DEPTH = 32;

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The addresses a signed comment names for its own community. A record may
 * carry a name, a public key, or both (plus the pre-rename field on old
 * comments); every well-formed one is returned, since a name can stop
 * resolving while its key still works.
 */
export function communityAddressesOf(comment: any): string[] {
  const found = new Set<string>();
  for (const value of [comment?.communityName, comment?.communityPublicKey, comment?.communityAddress, comment?.subplebbitAddress]) {
    if (typeof value === 'string' && isAddress(value)) found.add(normalizeAddress(value));
  }
  return [...found];
}

function addMentions(into: Harvest, ...texts: unknown[]): void {
  for (const text of texts) for (const address of addressesInText(text)) into.mentions.add(address);
}

function addPreviousCommentCid(into: Harvest, author: any): void {
  const cid = author?.previousCommentCid;
  if (typeof cid === 'string' && CID.test(cid)) into.previousCommentCids.add(cid);
}

function harvestCrosspost(crosspost: any, into: Harvest, depth: number): void {
  const original = crosspost?.comment;
  if (!original || typeof original !== 'object' || depth >= MAX_CROSSPOST_DEPTH) return;
  for (const address of communityAddressesOf(original)) into.crossposts.add(address);
  addMentions(into, original.title, original.content, original.link);
  harvestCrosspost(original.crosspost, into, depth + 1);
}

/**
 * Harvest one comment. Accepts a pkc-js page comment (flattened fields, the
 * signed record under `raw.comment`) or a bare CommentIpfs, and walks any
 * preloaded reply pages it carries.
 */
export function harvestComment(comment: any, into: Harvest = emptyHarvest(), depth = 0): Harvest {
  if (!comment || typeof comment !== 'object') return into;
  const signed = comment.raw?.comment ?? comment;
  addMentions(into, comment.title, comment.content, comment.link, signed.title, signed.content, signed.link);
  addPreviousCommentCid(into, signed.author);
  addPreviousCommentCid(into, comment.author);
  // pkc-js may normalize the flattened crosspost; the signed copy is untouched.
  harvestCrosspost(signed.crosspost ?? comment.crosspost, into, 0);
  if (depth < MAX_REPLY_DEPTH) {
    for (const page of Object.values(comment.replies?.pages ?? {})) {
      for (const reply of (page as any)?.comments ?? []) harvestComment(reply, into, depth + 1);
    }
  }
  return into;
}

/** Harvest a community record: its own text plus every preloaded post page. */
export function harvestCommunity(community: any, into: Harvest = emptyHarvest()): Harvest {
  if (!community || typeof community !== 'object') return into;
  addMentions(into, community.title, community.description);
  if (Array.isArray(community.rules)) addMentions(into, ...community.rules);
  for (const page of Object.values(community.posts?.pages ?? {})) {
    for (const comment of (page as any)?.comments ?? []) harvestComment(comment, into);
  }
  return into;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
