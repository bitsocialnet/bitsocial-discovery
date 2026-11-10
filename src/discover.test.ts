import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { communityViews } from './api/view.js';
import { config } from './config.js';
import {
  addCandidate,
  deferCandidate,
  getCandidate,
  getDb,
  recordSubmission,
  resetDbForTest,
  sourcesByAddress,
} from './db/index.js';
import { backoffSeconds, refreshSources, setDepsForTest, SUBMISSION_GIVE_UP_FAILURES, tick } from './discover.js';
import { parseOverrides, setOverrides } from './overrides.js';
import type { PkcClient } from './pkc/client.js';
import { nowSec } from './util.js';

const KEY_A = '12D3KooWNv5HzmkcKZkxMn1SrfMyozTdTJSr7kA1bzEKKa7PTS5N';
const KEY_B = '12D3KooWFkZorC92RxQAwMBYMido8xBM88ghpLWA26mrE9W9Xmxd';
const KEY_C = '12D3KooWFL5oGc9p9CYs25eeK5cCpPXXhibECsnqmuxinq2jbtjP';
const KEY_D = '12D3KooWCqU7kP2fJwaDrV8mQ3gKxbEsW9nR4hLycFtXAoS5iMzd';
const CID_1 = 'QmULtQscGrFmc4qcZDbsZMFxyJT1qT3qQVZ28Vc1YhbwLq';
const CID_2 = 'QmemhNu7rQum2TCKHJn1h7UqUmtRV1jtcdLXNfoXCt7nn5';

const mutableConfig = config as unknown as Record<string, unknown>;

function fakePkc(communities: Record<string, unknown>, comments: Record<string, unknown> = {}) {
  const calls = { communities: [] as string[], comments: [] as string[] };
  const client: PkcClient = {
    getCommunity: async (address) => {
      calls.communities.push(address);
      const c = communities[address];
      if (!c) throw new Error(`no such community ${address}`);
      return c;
    },
    getComment: async (cid) => {
      calls.comments.push(cid);
      const c = comments[cid];
      if (!c) throw new Error(`no such comment ${cid}`);
      return c;
    },
    destroy: async () => {},
  };
  setDepsForTest({ pkc: async () => client });
  return calls;
}

function sourcesOf(address: string): string[] {
  return (sourcesByAddress().get(address) ?? []).map((s) => `${s.type}:${s.via}`).sort();
}

function makeDue(address: string): void {
  deferCandidate(address, 0);
}

beforeEach(() => {
  resetDbForTest();
  getDb();
});

afterEach(() => {
  setDepsForTest(null);
  setOverrides(new Map());
  mutableConfig.indexerUrls = [];
});

const seedCommunity = {
  address: 'seed.bso',
  name: 'seed.bso',
  publicKey: KEY_A,
  title: 'Seed',
  description: 'friends: friend.bso',
  createdAt: 100,
  updatedAt: 200,
  features: { safeForWork: false, pseudonymityMode: 'per-post' },
  suggested: { uiType: 'author' },
  posts: {
    pages: {
      hot: {
        comments: [
          {
            content: 'look at mentioned.bso',
            raw: {
              comment: {
                author: { previousCommentCid: CID_1 },
                crosspost: { comment: { communityPublicKey: KEY_B } },
              },
            },
          },
        ],
      },
    },
  },
};

test('a resolved seed is stored and expanded through mentions, crossposts and author chains', async () => {
  const calls = fakePkc(
    { 'seed.bso': seedCommunity },
    {
      [CID_1]: { raw: { comment: { communityName: 'chain.bso', author: { previousCommentCid: CID_2 } } } },
      [CID_2]: { communityAddress: 'deeper.bso' },
    },
  );
  addCandidate('seed.bso', 'seed', 'SEEDS', nowSec());
  assert.equal(await tick(), 1);

  const row = getDb().prepare('SELECT * FROM communities').get() as Record<string, unknown>;
  assert.equal(row.public_key, KEY_A);
  assert.equal(row.address, 'seed.bso');
  assert.equal(row.title, 'Seed');
  assert.equal(row.safe_for_work, 0);
  assert.equal(row.pseudonymity_mode, 'per-post');
  assert.equal(row.ui_type, 'author');
  assert.equal(getCandidate('seed.bso')?.public_key, KEY_A);

  assert.deepEqual(sourcesOf('friend.bso'), ['mention:seed.bso']);
  assert.deepEqual(sourcesOf('mentioned.bso'), ['mention:seed.bso']);
  assert.deepEqual(sourcesOf(KEY_B), ['crosspost:seed.bso']);
  assert.deepEqual(sourcesOf('chain.bso'), ['author-chain:seed.bso']);
  assert.deepEqual(sourcesOf('deeper.bso'), ['author-chain:seed.bso']);
  assert.deepEqual(calls.comments, [CID_1, CID_2]);

  // A second check reuses the walked chain instead of fetching it again.
  makeDue('seed.bso');
  await tick();
  assert.deepEqual(calls.comments, [CID_1, CID_2]);
});

test('a failing candidate backs off exponentially and keeps its error', async () => {
  fakePkc({});
  addCandidate('gone.bso', 'seed', 'SEEDS', nowSec());
  await tick();
  let row = getCandidate('gone.bso')!;
  assert.equal(row.failures, 1);
  assert.match(row.last_error ?? '', /no such community/);
  assert.ok(row.next_check_at >= nowSec() + backoffSeconds(1) - 1);

  makeDue('gone.bso');
  await tick();
  row = getCandidate('gone.bso')!;
  assert.equal(row.failures, 2);
  assert.equal(backoffSeconds(2), backoffSeconds(1) * 2);
  assert.equal(backoffSeconds(1_000), Math.ceil(config.retryMaxMs / 1000));
});

test('an address only the submissions API pointed at is dropped after repeated failures; one also found elsewhere is kept', async () => {
  fakePkc({});
  recordSubmission('ghost.bso', nowSec(), 10);
  recordSubmission('linked.bso', nowSec(), 10);
  addCandidate('linked.bso', 'mention', 'seed.bso', nowSec());
  const failAll = async () => {
    makeDue('ghost.bso');
    makeDue('linked.bso');
    await tick();
  };

  for (let i = 1; i < SUBMISSION_GIVE_UP_FAILURES; i++) await failAll();
  assert.equal(getCandidate('ghost.bso')?.failures, SUBMISSION_GIVE_UP_FAILURES - 1);

  await failAll();
  assert.equal(getCandidate('ghost.bso'), undefined);
  assert.deepEqual(sourcesOf('ghost.bso'), []);
  assert.equal(getCandidate('linked.bso')?.failures, SUBMISSION_GIVE_UP_FAILURES);
});

test('a blocked address is never fetched; a blocked key is stored but not harvested', async () => {
  setOverrides(parseOverrides([{ address: 'bad.bso', status: 'blocked' }, { address: KEY_C, status: 'blocked' }]));
  const calls = fakePkc({
    'renamed.bso': { address: 'renamed.bso', name: 'renamed.bso', publicKey: KEY_C, description: 'see leak.bso' },
  });
  addCandidate('bad.bso', 'seed', 'SEEDS', nowSec());
  addCandidate('renamed.bso', 'seed', 'SEEDS', nowSec());
  await tick();

  assert.deepEqual(calls.communities, ['renamed.bso']);
  assert.ok(getCandidate('bad.bso')!.next_check_at > nowSec() + 24 * 3600);
  assert.equal(getCandidate('leak.bso'), undefined);

  // Once its key is known, the blocked community is not fetched again.
  makeDue('renamed.bso');
  await tick();
  assert.deepEqual(calls.communities, ['renamed.bso']);
});

test('a name the record claims but does not resolve to its key is not used as the address', async () => {
  fakePkc({ [KEY_B]: { address: 'spoof.bso', name: 'spoof.bso', nameResolved: false, publicKey: KEY_B } });
  addCandidate(KEY_B, 'ens', '0xnode', nowSec());
  await tick();
  const row = getDb().prepare('SELECT address, name FROM communities').get() as { address: string; name: string | null };
  assert.deepEqual({ ...row }, { address: KEY_B, name: null });
});

function storedAddress(publicKey: string): { address: string; name: string | null } | undefined {
  const row = getDb().prepare('SELECT address, name FROM communities WHERE public_key = ?').get(publicKey);
  return row ? { ...(row as { address: string; name: string | null }) } : undefined;
}

test('a name a key-loaded record claims becomes its address only once it is verified', async () => {
  setOverrides(parseOverrides([{ address: 'memes.bso', status: 'approved' }]));
  // pkc-js answers before it has checked a key-loaded record's name, so nameResolved is
  // usually still undefined: the claim is unverified.
  fakePkc({
    'memes.bso': { name: 'memes.bso', publicKey: KEY_A, title: 'Memes' },
    [KEY_B]: { name: 'memes.bso', publicKey: KEY_B, title: 'Not memes' },
    [KEY_C]: { name: 'real.bso', publicKey: KEY_C, title: 'Real' },
    'real.bso': { name: 'real.bso', publicKey: KEY_C, title: 'Real' },
    [KEY_D]: { name: 'checked.bso', nameResolved: true, publicKey: KEY_D },
  });
  addCandidate('memes.bso', 'seed', 'SEEDS', nowSec());
  addCandidate(KEY_B, 'submission', 'api', nowSec());
  addCandidate(KEY_C, 'ens', '0xnode', nowSec());
  addCandidate(KEY_D, 'ens', '0xnode', nowSec());
  await tick();

  // Another key claiming memes.bso is listed under its own key, without memes.bso's verdict.
  assert.deepEqual(storedAddress(KEY_B), { address: KEY_B, name: null });
  assert.deepEqual(storedAddress(KEY_A), { address: 'memes.bso', name: 'memes.bso' });
  const reviews = Object.fromEntries(communityViews(true).map((c) => [c.publicKey, c.review]));
  assert.equal(reviews[KEY_A], 'approved');
  assert.equal(reviews[KEY_B], 'unreviewed');
  // A name pkc-js has verified is used at once.
  assert.deepEqual(storedAddress(KEY_D), { address: 'checked.bso', name: 'checked.bso' });

  // An unverified name is checked on its own, and once it resolves to the key it is the address.
  assert.deepEqual(storedAddress(KEY_C), { address: KEY_C, name: null });
  assert.deepEqual(sourcesOf('real.bso'), [`mention:${KEY_C}`]);
  await tick();
  assert.deepEqual(storedAddress(KEY_C), { address: 'real.bso', name: 'real.bso' });
  makeDue(KEY_C);
  await tick();
  assert.deepEqual(storedAddress(KEY_C), { address: 'real.bso', name: 'real.bso' });
});

test('a block or hide on a name a record claims applies before the name is verified', async () => {
  setOverrides(
    parseOverrides([
      { address: 'spam.bso', status: 'blocked', reason: 'report' },
      { address: 'quiet.bso', status: 'hidden', nsfw: true },
    ]),
  );
  // A list entry naming a community by name and key: the blocked name is never fetched, so the
  // key's claim to it can never be verified.
  const calls = fakePkc({
    [KEY_C]: { name: 'spam.bso', publicKey: KEY_C, description: 'see leak.bso' },
    [KEY_D]: { name: 'quiet.bso', publicKey: KEY_D, description: 'see next.bso' },
  });
  addCandidate('spam.bso', 'seed', 'list.json', nowSec());
  addCandidate(KEY_C, 'seed', 'list.json', nowSec());
  addCandidate(KEY_D, 'ens', '0xnode', nowSec());
  await tick();
  assert.deepEqual([...calls.communities].sort(), [KEY_C, KEY_D].sort());

  // Neither takes the claimed name as its address, but both keep its restriction.
  assert.deepEqual(storedAddress(KEY_C), { address: KEY_C, name: null });
  assert.deepEqual(storedAddress(KEY_D), { address: KEY_D, name: null });
  const views = communityViews(true);
  assert.deepEqual(Object.fromEntries(views.map((c) => [c.publicKey, c.review])), { [KEY_C]: 'blocked', [KEY_D]: 'hidden' });
  assert.equal(views.find((c) => c.publicKey === KEY_C)?.reason, 'report');
  assert.equal(views.find((c) => c.publicKey === KEY_D)?.nsfw, true);
  assert.deepEqual(communityViews(false), [], 'neither is listed publicly');
  assert.equal(getCandidate('leak.bso'), undefined, 'a blocked community is not harvested');
  assert.deepEqual(sourcesOf('next.bso'), [`mention:${KEY_D}`], 'a hidden one still is');

  // Not fetched again under its key, although the name it claims never resolved.
  makeDue(KEY_C);
  await tick();
  assert.equal(calls.communities.filter((a) => a === KEY_C).length, 1, 'not fetched again under its key');
  assert.ok(getCandidate(KEY_C)!.next_check_at > nowSec() + 24 * 3600);
});

test('a block on any address of a known community stops it being fetched under its other addresses', async () => {
  // A list entry that names a community by name and key makes two candidates for one community.
  const spam = { name: 'spam.bso', publicKey: KEY_C, description: 'see leak.bso' };
  const other = { name: 'other.bso', publicKey: KEY_D };
  const calls = fakePkc({ 'spam.bso': spam, [KEY_C]: spam, 'other.bso': other, [KEY_D]: other });
  addCandidate('spam.bso', 'seed', 'list.json', nowSec());
  addCandidate(KEY_C, 'seed', 'list.json', nowSec());
  addCandidate('other.bso', 'seed', 'list.json', nowSec());
  const fetchesOf = (...addresses: string[]) => calls.communities.filter((a) => addresses.includes(a)).length;
  await tick();
  assert.equal(fetchesOf('spam.bso', KEY_C, 'other.bso'), 3);

  setOverrides(parseOverrides([{ address: 'spam.bso', status: 'blocked' }, { address: 'other.bso', status: 'blocked' }]));
  makeDue('spam.bso');
  makeDue(KEY_C);
  // A crosspost names other.bso's community by its key after the block.
  addCandidate(KEY_D, 'crosspost', 'elsewhere.bso', nowSec());
  await tick();
  assert.equal(fetchesOf('spam.bso', KEY_C, 'other.bso', KEY_D), 3, 'no address of either is fetched again');
  assert.ok(getCandidate(KEY_C)!.next_check_at > nowSec() + 24 * 3600);
  assert.ok(getCandidate(KEY_D)!.next_check_at > nowSec() + 24 * 3600);
});

test('refreshSources reads indexer communities and credits comment pointers to their community', async () => {
  fakePkc({});
  mutableConfig.indexerUrls = ['https://idx.example'];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/communities')) return new Response(JSON.stringify({ communities: [{ address: 'indexed.bso' }] }));
    return new Response(
      JSON.stringify({
        posts: [
          {
            cid: CID_1,
            community_address: 'indexed.bso',
            timestamp: nowSec() - 10,
            title: 'new place: elsewhere.bso',
            content: null,
            link: null,
            raw: JSON.stringify({ comment: { crosspost: { comment: { communityName: 'origin.bso' } } } }),
          },
        ],
      }),
    );
  }) as typeof fetch;
  try {
    await refreshSources();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sourcesOf('indexed.bso'), ['indexer:https://idx.example']);
  assert.deepEqual(sourcesOf('elsewhere.bso'), ['mention:indexed.bso']);
  assert.deepEqual(sourcesOf('origin.bso'), ['crosspost:indexed.bso']);
});
