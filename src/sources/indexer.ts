/**
 * A bitsocial-indexer instance as a source: the communities it indexes, and
 * the comments it has archived, read newest-first through its public API.
 * The API serves each comment's signed record as `raw`, so crossposts and
 * `author.previousCommentCid` are available without fetching anything from
 * the network. One cursor per indexer (the newest comment timestamp read)
 * keeps later reads to what is new.
 */

/** Newest-first pages of 100; a first read stops after this many. */
const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 30_000;

export interface IndexedComment {
  cid: string;
  community_address: string;
  timestamp: number;
  title: string | null;
  content: string | null;
  link: string | null;
  /** pkc-js `comment.raw`: `{ comment: CommentIpfs, commentUpdate?: … }`, parsed. */
  raw: unknown;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export async function indexerCommunities(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const data = (await getJson(apiUrl(baseUrl, '/api/communities'), fetchImpl)) as { communities?: { address?: unknown }[] };
  return (data.communities ?? []).map((c) => c?.address).filter((a): a is string => typeof a === 'string');
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Comments posted at or after `cursor` (unix seconds), newest first, plus the
 * cursor for next time. Timestamps are author-claimed, so the new cursor never
 * moves past `now`: a comment dated in the future must not hide everything
 * posted before that date.
 */
export async function indexerCommentsSince(
  baseUrl: string,
  cursor: number,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ comments: IndexedComment[]; cursor: number }> {
  const comments: IndexedComment[] = [];
  let newest = cursor;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = apiUrl(baseUrl, `/api/posts?sort=new&replies=true&limit=${PAGE_SIZE}&page=${page}`);
    const data = (await getJson(url, fetchImpl)) as { posts?: Record<string, unknown>[] };
    const rows = data.posts ?? [];
    let reachedCursor = false;
    for (const row of rows) {
      const timestamp = typeof row.timestamp === 'number' ? row.timestamp : 0;
      if (timestamp < cursor) {
        reachedCursor = true;
        continue;
      }
      if (typeof row.cid !== 'string' || typeof row.community_address !== 'string') continue;
      comments.push({
        cid: row.cid,
        community_address: row.community_address,
        timestamp,
        title: typeof row.title === 'string' ? row.title : null,
        content: typeof row.content === 'string' ? row.content : null,
        link: typeof row.link === 'string' ? row.link : null,
        raw: parseRaw(row.raw),
      });
      newest = Math.max(newest, Math.min(timestamp, now));
    }
    if (reachedCursor || rows.length < PAGE_SIZE) break;
  }
  return { comments, cursor: newest };
}
