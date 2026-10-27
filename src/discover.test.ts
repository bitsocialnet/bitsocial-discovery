import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
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
