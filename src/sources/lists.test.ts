import assert from 'node:assert/strict';
import test from 'node:test';
import { addressesInList } from './lists.js';

const KEY = '12D3KooWNv5HzmkcKZkxMn1SrfMyozTdTJSr7kA1bzEKKa7PTS5N';

test('addressesInList reads arrays, communities and boards, keeping names and keys', () => {
  assert.deepEqual(addressesInList(['A.bso', KEY, 'junk', 7]), ['a.bso', KEY]);
  assert.deepEqual(addressesInList({ communities: [{ address: 'askseedit.bso', publicKey: KEY }] }), ['askseedit.bso', KEY]);
  assert.deepEqual(addressesInList({ communities: ['one.bso'], boards: [{ address: 'two.bso' }] }), ['one.bso', 'two.bso']);
  assert.deepEqual(addressesInList({ nothing: true }), []);
  assert.deepEqual(addressesInList(null), []);
});
