import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { config } from '../config.js';
import { addCandidate, getDb, markResolved, resetDbForTest, upsertCommunity } from '../db/index.js';
import { parseOverrides, setOverrides } from '../overrides.js';
import { buildServer, parseAllowedOrigins } from './server.js';

const KEY_A = '12D3KooWNv5HzmkcKZkxMn1SrfMyozTdTJSr7kA1bzEKKa7PTS5N';
const KEY_B = '12D3KooWFkZorC92RxQAwMBYMido8xBM88ghpLWA26mrE9W9Xmxd';
const KEY_C = '12D3KooWFL5oGc9p9CYs25eeK5cCpPXXhibECsnqmuxinq2jbtjP';
const KEY_D = '12D3KooWSTGtTvMSLu1Vdg3VBkg4z7JVqYmDNWQJnRMAmrNrKySm';

const mutableConfig = config as unknown as Record<string, unknown>;

function community(publicKey: string, address: string, extra: Partial<Parameters<typeof upsertCommunity>[0]> = {}) {
  upsertCommunity({
    public_key: publicKey,
    address,
    name: address === publicKey ? null : address,
    title: null,
    description: null,
    created_at: null,
    updated_at: null,
    pseudonymity_mode: null,
    safe_for_work: null,
    ui_type: null,
    last_resolved_at: 1_000,
    ...extra,
  });
}

beforeEach(() => {
  resetDbForTest();
  getDb();
  // Found as a name and as its key: one community, two aliases.
  addCandidate('memes.bso', 'seed', 'lists', 10);
  addCandidate(KEY_A, 'ens', '0xnode', 20);
  markResolved('memes.bso', KEY_A, 30, 99);
  markResolved(KEY_A, KEY_A, 30, 99);
  community(KEY_A, 'memes.bso', { title: 'Memes', updated_at: 500, safe_for_work: 1 });
  community(KEY_B, 'board.bso', { pseudonymity_mode: 'per-post', updated_at: 900, safe_for_work: 0 });
  community(KEY_C, KEY_C, { ui_type: 'author' });
  community(KEY_D, 'secret.bso');
  setOverrides(
    parseOverrides([
      { address: 'memes.bso', status: 'approved' },
      { address: KEY_B, status: 'listed' },
      { address: 'secret.bso', status: 'hidden', reason: 'pending review' },
    ]),
  );
});

afterEach(() => {
  setOverrides(new Map());
  mutableConfig.publicListing = 'all';
  mutableConfig.adminToken = '';
});

async function get(url: string, headers: Record<string, string> = {}) {
  const app = await buildServer();
  try {
    const res = await app.inject({ method: 'GET', url, headers });
    return { status: res.statusCode, body: res.json() };
  } finally {
    await app.close();
  }
}

test('the public list hides hidden communities and profiles, and merges aliases', async () => {
  const { body } = await get('/api/communities?sort=updated');
  assert.deepEqual(body.communities.map((c: { address: string }) => c.address), ['board.bso', 'memes.bso']);
  const memes = body.communities[1];
  assert.deepEqual(memes.aliases, [KEY_A, 'memes.bso'].sort());
  assert.deepEqual(memes.sources.map((s: { type: string }) => s.type), ['seed', 'ens']);
  assert.equal(memes.review, 'approved');
  assert.equal(memes.nsfw, false);
  assert.equal(body.communities[0].nsfw, true);
  assert.equal(memes.reason, undefined);
});

test('filters: review, pseudonymous, uiType, paging', async () => {
  const approved = await get('/api/communities?review=approved');
  assert.deepEqual(approved.body.communities.map((c: { address: string }) => c.address), ['memes.bso']);

  const boards = await get('/api/communities?pseudonymous=true');
  assert.deepEqual(boards.body.communities.map((c: { address: string }) => c.address), ['board.bso']);

  const profiles = await get('/api/communities?uiType=author');
  assert.deepEqual(profiles.body.communities.map((c: { address: string }) => c.address), [KEY_C]);

  const paged = await get('/api/communities?uiType=any&sort=title&limit=1&page=2');
  assert.equal(paged.body.total, 3);
  assert.equal(paged.body.communities.length, 1);

  const bad = await get('/api/communities?review=hidden');
  assert.equal(bad.status, 400);
});

test('PUBLIC_LISTING=reviewed shows only approved and listed communities', async () => {
  mutableConfig.publicListing = 'reviewed';
  community('12D3KooWQ4bCzsz6UBuVftUMTTaVuxrSrb2vNw6egfo2LYtngNUg', 'fresh.bso');
  const { body } = await get('/api/communities?uiType=any');
  assert.deepEqual(body.communities.map((c: { address: string }) => c.address).sort(), ['board.bso', 'memes.bso']);
});

test('the admin token sees hidden communities, reasons and candidates', async () => {
  mutableConfig.adminToken = 'secret-token';
  assert.equal((await get('/api/candidates')).status, 401);
  assert.equal((await get('/api/candidates', { authorization: 'Bearer wrong-token!' })).status, 401);

  const auth = { authorization: 'Bearer secret-token' };
  const hidden = await get('/api/communities?review=hidden', auth);
  assert.equal(hidden.body.communities[0].address, 'secret.bso');
  assert.equal(hidden.body.communities[0].reason, 'pending review');

  const candidates = await get('/api/candidates', auth);
  assert.equal(candidates.body.total, 2);
  assert.equal(candidates.body.candidates.find((c: { address: string }) => c.address === 'memes.bso').status, 'resolved');
});

test('a single community is found by any alias, and hidden ones are not found publicly', async () => {
  assert.equal((await get(`/api/communities/${KEY_A}`)).body.address, 'memes.bso');
  assert.equal((await get('/api/communities/MEMES.bso')).body.publicKey, KEY_A);
  assert.equal((await get('/api/communities/secret.bso')).status, 404);
});

test('parseAllowedOrigins matches bitsocial-indexer: "*" is any origin, wildcards stay inside the host', () => {
  assert.equal(parseAllowedOrigins('*'), true);
  const [exact, wildcard] = parseAllowedOrigins('https://seedit.app, https://*.seedit.localhost') as [string, RegExp];
  assert.equal(exact, 'https://seedit.app');
  assert.ok(wildcard.test('https://feature.seedit.localhost'));
  assert.ok(!wildcard.test('https://x.seeditXlocalhost'));
});
