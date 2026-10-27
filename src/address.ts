/**
 * Community addresses as discovery sees them: a domain (`name.bso`, or the
 * `name.eth` it aliases) or an IPNS public key (`12D3KooW…` base58, or the
 * `k51…` base36 form). Both kinds turn up in posts, lists and ENS records, so
 * this is the one place that decides what counts as an address.
 */

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_BODY = `(?:${LABEL}\\.)+(?:bso|eth)`;
const BASE58 = '1-9A-HJ-NP-Za-km-z';
const ED25519_PEER_ID = `12D3KooW[${BASE58}]{44}`;
const BASE36_IPNS_KEY = 'k51qzi5uqu5[a-z0-9]{48,52}';

const EXACT = new RegExp(`^(?:${DOMAIN_BODY}|${ED25519_PEER_ID}|${BASE36_IPNS_KEY})$`, 'i');

/**
 * Domain mentions. The lookbehind keeps `foo@bar.eth` from matching mid-token;
 * the lookahead stops `name.bsoxyz` and `name.bso.example.com`, while still
 * allowing a sentence's closing period.
 */
const DOMAIN_IN_TEXT = new RegExp(`(?<![\\w@.-])(${DOMAIN_BODY})(?![\\w-]|\\.[\\w-])`, 'gi');
const PEER_ID_IN_TEXT = new RegExp(`(?<![${BASE58}])(${ED25519_PEER_ID})(?![${BASE58}])`, 'g');
const BASE36_IN_TEXT = new RegExp(`(?<![a-z0-9])(${BASE36_IPNS_KEY})(?![a-z0-9])`, 'g');

/** Lowercase domains (ENS names are case-insensitive); keys keep their case. */
export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  return /\.(?:bso|eth)$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** True for a well-formed domain or IPNS key. Says nothing about whether it resolves. */
export function isAddress(value: string): boolean {
  return EXACT.test(value.trim());
}

/** Every community-shaped address mentioned in a piece of text or a URL, deduplicated. */
export function addressesInText(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  const found = new Set<string>();
  for (const re of [DOMAIN_IN_TEXT, PEER_ID_IN_TEXT, BASE36_IN_TEXT]) {
    for (const match of text.matchAll(re)) found.add(normalizeAddress(match[1]!));
  }
  return [...found];
}
