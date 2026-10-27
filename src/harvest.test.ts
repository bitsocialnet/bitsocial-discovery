import assert from 'node:assert/strict';
import test from 'node:test';
import { communityAddressesOf, harvestComment, harvestCommunity } from './harvest.js';

const KEY_A = '12D3KooWNv5HzmkcKZkxMn1SrfMyozTdTJSr7kA1bzEKKa7PTS5N';
const KEY_B = '12D3KooWFkZorC92RxQAwMBYMido8xBM88ghpLWA26mrE9W9Xmxd';
const CID_1 = 'QmULtQscGrFmc4qcZDbsZMFxyJT1qT3qQVZ28Vc1YhbwLq';
const CID_2 = 'QmemhNu7rQum2TCKHJn1h7UqUmtRV1jtcdLXNfoXCt7nn5';

test('communityAddressesOf returns every well-formed identifier of a signed comment', () => {
  assert.deepEqual(communityAddressesOf({ communityName: 'Art.bso', communityPublicKey: KEY_A }).sort(), ['art.bso', KEY_A].sort());
  assert.deepEqual(communityAddressesOf({ subplebbitAddress: 'old.eth' }), ['old.eth']);
  assert.deepEqual(communityAddressesOf({ communityAddress: 'not an address' }), []);
});

test('harvestComment reads mentions, crossposts and previousCommentCid from the signed record', () => {
  const comment = {
    title: 'see art.bso',
    raw: {
      comment: {
        content: `also ${KEY_B}`,
        author: { previousCommentCid: CID_1 },
        crosspost: {
          cid: CID_2,
          comment: {
            communityName: 'origin.bso',
            content: 'from nested.bso',
            crosspost: { comment: { communityPublicKey: KEY_A } },
          },
        },
      },
    },
  };
  const h = harvestComment(comment);
  assert.deepEqual([...h.mentions].sort(), ['art.bso', 'nested.bso', KEY_B].sort());
  assert.deepEqual([...h.crossposts].sort(), ['origin.bso', KEY_A].sort());
  assert.deepEqual([...h.previousCommentCids], [CID_1]);
});

test('harvestComment ignores a malformed previousCommentCid', () => {
  assert.equal(harvestComment({ author: { previousCommentCid: 'nope' } }).previousCommentCids.size, 0);
});

test('harvestCommunity walks description, rules, preloaded posts and their preloaded replies', () => {
  const community = {
    description: 'sister community: sister.bso',
    rules: ['no spam', 'ask in help.eth'],
    posts: {
      pages: {
        hot: {
          comments: [
            {
              content: 'post mentions post.bso',
              replies: { pages: { best: { comments: [{ content: 'reply mentions reply.bso', author: { previousCommentCid: CID_2 } }] } } },
            },
          ],
        },
      },
    },
  };
  const h = harvestCommunity(community);
  assert.deepEqual([...h.mentions].sort(), ['help.eth', 'post.bso', 'reply.bso', 'sister.bso']);
  assert.deepEqual([...h.previousCommentCids], [CID_2]);
});

test('harvest tolerates missing and hostile shapes', () => {
  assert.equal(harvestCommunity(null).mentions.size, 0);
  assert.equal(harvestCommunity({ posts: { pages: { hot: { comments: 'x' } } } }).mentions.size, 0);
  let crosspost: Record<string, unknown> = { comment: { communityName: 'deep.bso' } };
  for (let i = 0; i < 50; i++) crosspost = { comment: { communityName: `level${i}.bso`, crosspost } };
  const h = harvestComment({ raw: { comment: { crosspost } } });
  assert.ok(h.crossposts.size <= 8, `crosspost recursion is bounded (got ${h.crossposts.size})`);
});
