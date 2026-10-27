import assert from 'node:assert/strict';
import test from 'node:test';
import { addressesInText, isAddress, normalizeAddress } from './address.js';

const KEY = '12D3KooWNv5HzmkcKZkxMn1SrfMyozTdTJSr7kA1bzEKKa7PTS5N';
const BASE36 = 'k51qzi5uqu5dl6dk0zoaocksijnghdrkxir5m5yfcodish4df6re6v3wbl6njm';

test('domains and both IPNS key forms are addresses; other strings are not', () => {
  for (const ok of ['memes.bso', 'Memes.BSO', 'news-posting.eth', 'sub.name.eth', KEY, BASE36]) assert.ok(isAddress(ok), ok);
  for (const bad of ['memes', 'memes.com', '-bad.bso', `${KEY}x`, 'QmULtQscGrFmc4qcZDbsZMFxyJT1qT3qQVZ28Vc1YhbwLq', '']) {
    assert.ok(!isAddress(bad), bad);
  }
});

test('normalizeAddress lowercases domains but keeps key case', () => {
  assert.equal(normalizeAddress(' Memes.BSO '), 'memes.bso');
  assert.equal(normalizeAddress(KEY), KEY);
});

test('addressesInText finds domains, keys and URLs, deduplicated', () => {
  const text = `Try Funny.bso and funny.bso. Also https://seedit.app/#/s/${KEY} and ${BASE36}, plus art.eth!`;
  assert.deepEqual(addressesInText(text).sort(), [BASE36, KEY, 'art.eth', 'funny.bso'].sort());
});

test('addressesInText skips emails, longer hostnames and partial tokens', () => {
  assert.deepEqual(addressesInText('mail me@vitalik.eth or see name.bso.example.com and foo.bsox'), []);
  assert.deepEqual(addressesInText(`x${KEY}`), []);
});

test('addressesInText ignores non-strings', () => {
  assert.deepEqual(addressesInText(undefined), []);
  assert.deepEqual(addressesInText(42), []);
});
