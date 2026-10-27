/**
 * What the API returns for a community: its stored metadata, every address it
 * was found under, how it was found, and the operator's verdict, combined.
 * Visibility rules live here so every endpoint applies the same ones.
 */
import { config } from '../config.js';
import {
  aliasesByKey,
  allCandidates,
  allCommunities,
  sourcesByAddress,
  type CandidateRow,
  type CommunityRow,
  type SourceRow,
} from '../db/index.js';
import { overrideFor, type ReviewStatus } from '../overrides.js';

export type Review = ReviewStatus | 'unreviewed';

export interface CommunityView {
  address: string;
  publicKey: string;
  name: string | null;
  /** Every address discovery found this community under. */
  aliases: string[];
  title: string | null;
  description: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  firstSeenAt: number;
  lastResolvedAt: number;
  pseudonymityMode: string | null;
  safeForWork: boolean | null;
  uiType: string | null;
  review: Review;
  /** Operator verdict first, then the owner's safeForWork; null when neither says. */
  nsfw: boolean | null;
  sources: { type: string; via: string; firstSeenAt: number }[];
  reason?: string;
}

function view(row: CommunityRow, aliases: string[], sources: Map<string, SourceRow[]>, admin: boolean): CommunityView {
  const addresses = [...new Set([row.address, row.public_key, ...(row.name ? [row.name] : []), ...aliases])];
  const override = overrideFor(addresses);
  const found = addresses
    .flatMap((a) => sources.get(a) ?? [])
    .sort((a, b) => a.first_seen_at - b.first_seen_at)
    .map((s) => ({ type: s.type, via: s.via, firstSeenAt: s.first_seen_at }));
  const safeForWork = row.safe_for_work === null ? null : row.safe_for_work === 1;
  return {
    address: row.address,
    publicKey: row.public_key,
    name: row.name,
    aliases,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firstSeenAt: row.first_seen_at,
    lastResolvedAt: row.last_resolved_at,
    pseudonymityMode: row.pseudonymity_mode,
    safeForWork,
    uiType: row.ui_type,
    review: override.status ?? 'unreviewed',
    nsfw: override.nsfw ?? (safeForWork === null ? null : !safeForWork),
    sources: found,
    ...(admin && override.reason ? { reason: override.reason } : {}),
  };
}

/** Hidden and blocked never reach the public; "reviewed" listing also drops unreviewed. */
export function isPublic(review: Review): boolean {
  if (review === 'hidden' || review === 'blocked') return false;
  return config.publicListing === 'all' || review !== 'unreviewed';
}

export function communityViews(admin: boolean): CommunityView[] {
  const aliases = aliasesByKey();
  const sources = sourcesByAddress();
  return allCommunities()
    .map((row) => view(row, aliases.get(row.public_key) ?? [], sources, admin))
    .filter((c) => admin || isPublic(c.review));
}

export interface CandidateView {
  address: string;
  status: 'resolved' | 'failing' | 'pending';
  publicKey: string | null;
  firstSeenAt: number;
  nextCheckAt: number;
  lastCheckedAt: number | null;
  lastResolvedAt: number | null;
  failures: number;
  lastError: string | null;
  sources: { type: string; via: string; firstSeenAt: number }[];
}

/** Every address discovery knows, for operators. Not filtered: admin only. */
export function candidateViews(): CandidateView[] {
  const sources = sourcesByAddress();
  return allCandidates().map((c: CandidateRow) => ({
    address: c.address,
    status: c.failures > 0 ? 'failing' : c.last_resolved_at ? 'resolved' : 'pending',
    publicKey: c.public_key,
    firstSeenAt: c.first_seen_at,
    nextCheckAt: c.next_check_at,
    lastCheckedAt: c.last_checked_at,
    lastResolvedAt: c.last_resolved_at,
    failures: c.failures,
    lastError: c.last_error,
    sources: (sources.get(c.address) ?? []).map((s) => ({ type: s.type, via: s.via, firstSeenAt: s.first_seen_at })),
  }));
}
