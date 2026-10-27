import assert from 'node:assert/strict';
import test from 'node:test';
import { indexerCommentsSince, indexerCommunities } from './indexer.js';

function fakeFetch(pages: Record<number, unknown[]>, communities: unknown[] = []): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/api/communities')) return new Response(JSON.stringify({ communities }));
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify({ posts: pages[page] ?? [] }));
  }) as typeof fetch;
  return { fetch: impl, urls };
}

const row = (cid: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
  cid,
  community_address: 'memes.bso',
  timestamp,
  title: null,
  content: 'hi',
  link: null,
  raw: JSON.stringify({ comment: { author: {} } }),
  ...extra,
});

test('indexerCommunities returns the addresses an indexer serves', async () => {
  const { fetch } = fakeFetch({}, [{ address: 'a.bso' }, { address: 5 }, {}]);
  assert.deepEqual(await indexerCommunities('https://api.example/', fetch), ['a.bso']);
});

test('indexerCommentsSince stops at the cursor and parses raw', async () => {
  const { fetch, urls } = fakeFetch({ 1: [row('c3', 300), row('c2', 200), row('c1', 100)] });
  const { comments, cursor } = await indexerCommentsSince('https://api.example', 200, 1_000, fetch);
  assert.deepEqual(comments.map((c) => c.cid), ['c3', 'c2']);
  assert.equal(cursor, 300);
  assert.deepEqual(comments[0]!.raw, { comment: { author: {} } });
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /\/api\/posts\?sort=new&replies=true&limit=100&page=1$/);
});

test('indexerCommentsSince never moves the cursor past now', async () => {
  const { fetch } = fakeFetch({ 1: [row('future', 9_999_999), row('c1', 100)] });
  const { cursor } = await indexerCommentsSince('https://api.example', 0, 1_000, fetch);
  assert.equal(cursor, 1_000);
});

test('indexerCommentsSince pages until a short page', async () => {
  const full = Array.from({ length: 100 }, (_, i) => row(`a${i}`, 500 - i));
  const { fetch, urls } = fakeFetch({ 1: full, 2: [row('b', 10)] });
  const { comments } = await indexerCommentsSince('https://api.example', 0, 1_000, fetch);
  assert.equal(comments.length, 101);
  assert.equal(urls.length, 2);
});
