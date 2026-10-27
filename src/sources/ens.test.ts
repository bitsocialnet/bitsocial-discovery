import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import { EnsRevertError, parseBitsocialRecord, scanEns, type EnsChain } from './ens.js';

const KEY = '12D3KooWNv5HzmkcKZkxMn1SrfMyozTdTJSr7kA1bzEKKa7PTS5N';
const KEY_2 = '12D3KooWFkZorC92RxQAwMBYMido8xBM88ghpLWA26mrE9W9Xmxd';
const node = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const ZERO = addr(0);

test('parseBitsocialRecord takes the public key from the first segment', () => {
  assert.equal(parseBitsocialRecord(`${KEY};foo=bar`), KEY);
  assert.equal(parseBitsocialRecord(` ${KEY} `), KEY);
  assert.equal(parseBitsocialRecord('memes.bso'), null);
  assert.equal(parseBitsocialRecord(''), null);
});

interface FakeLog {
  block: bigint;
  resolver: Hex;
  node: Hex;
}

function fakeChain(opts: {
  head: bigint;
  logs: FakeLog[];
  resolvers: Record<Hex, Hex>;
  texts: Record<string, string | Error>;
  maxSpan?: bigint;
  calls?: { from: bigint; to: bigint }[];
}): EnsChain {
  return {
    blockNumber: async () => opts.head,
    textChangedLogs: async (from, to) => {
      opts.calls?.push({ from, to });
      if (opts.maxSpan && to - from + 1n > opts.maxSpan) throw new Error('block range too large');
      return opts.logs
        .filter((l) => l.block >= from && l.block <= to)
        .map((l) => ({ address: l.resolver, topics: ['0xtopic' as Hex, l.node, '0xkey' as Hex] }));
    },
    resolverOf: async (n) => opts.resolvers[n] ?? ZERO,
    bitsocialText: async (resolver, n) => {
      const value = opts.texts[`${resolver}:${n}`];
      if (value instanceof Error) throw value;
      return value ?? '';
    },
  };
}

test('scanEns reads the current resolver, skips moved, empty and reverting records, and saves the cursor', async () => {
  const current = addr(1);
  const records: { node: Hex; publicKey: string }[] = [];
  let cursor: bigint | undefined;
  const chain = fakeChain({
    head: 1_000n + 12n,
    logs: [
      { block: 100n, resolver: addr(9), node: node(1) }, // logged by an old resolver
      { block: 200n, resolver: current, node: node(2) }, // record no longer a key
      { block: 300n, resolver: current, node: node(3) }, // resolver reverts
      { block: 400n, resolver: current, node: node(4) }, // no resolver any more
      { block: 500n, resolver: current, node: node(5) },
    ],
    resolvers: { [node(1)]: current, [node(2)]: current, [node(3)]: current, [node(5)]: current },
    texts: {
      [`${current}:${node(1)}`]: KEY,
      [`${current}:${node(2)}`]: 'not-a-key',
      [`${current}:${node(3)}`]: new EnsRevertError('reverted'),
      [`${current}:${node(5)}`]: `${KEY_2};x=y`,
    },
  });
  const n = await scanEns({
    chain,
    fromBlock: 0n,
    maxRange: 250n,
    cursor: undefined,
    saveCursor: (b) => (cursor = b),
    onRecord: (r) => records.push(r),
    pauseMs: 0,
  });
  assert.equal(n, 2);
  assert.deepEqual(records, [
    { node: node(1), publicKey: KEY },
    { node: node(5), publicKey: KEY_2 },
  ]);
  assert.equal(cursor, 1_000n, 'cursor stops at head minus confirmations');
});

test('scanEns halves a refused span, grows it back, and resumes after the cursor', async () => {
  const calls: { from: bigint; to: bigint }[] = [];
  const chain = fakeChain({ head: 10_000n + 12n, logs: [], resolvers: {}, texts: {}, maxSpan: 2_000n, calls });
  let cursor: bigint | undefined;
  await scanEns({ chain, fromBlock: 0n, maxRange: 8_000n, cursor: undefined, saveCursor: (b) => (cursor = b), onRecord: () => {}, pauseMs: 0 });
  assert.equal(cursor, 10_000n);
  assert.ok(calls.some((c) => c.to - c.from + 1n === 2_000n), 'shrank to an accepted span');
  assert.ok(calls.every((c, i) => i === 0 || c.from <= calls[i - 1]!.to + 1n), 'no gaps between ranges');

  calls.length = 0;
  await scanEns({ chain, fromBlock: 0n, maxRange: 8_000n, cursor, saveCursor: () => {}, onRecord: () => {}, pauseMs: 0 });
  assert.equal(calls.length, 0, 'nothing new to scan');
});

test('scanEns keeps the cursor before a range whose records could not be read', async () => {
  const current = addr(1);
  const chain = fakeChain({
    head: 500n + 12n,
    logs: [{ block: 300n, resolver: current, node: node(1) }],
    resolvers: { [node(1)]: current },
    texts: { [`${current}:${node(1)}`]: new Error('rpc down') },
  });
  let cursor: bigint | undefined;
  await assert.rejects(
    scanEns({ chain, fromBlock: 0n, maxRange: 200n, cursor: undefined, saveCursor: (b) => (cursor = b), onRecord: () => {}, pauseMs: 0 }),
    /rpc down/,
  );
  assert.equal(cursor, 199n, 'the failing range is scanned again next time');
});
