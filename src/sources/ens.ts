/**
 * ENS scan: every name whose resolver ever set a `bitsocial` text record.
 *
 * `.bso` names are aliases of `.eth` names, and clients resolve them through
 * the `bitsocial` text record (`<ipns public key>;key=value;…`, see
 * @bitsocial/bso-resolver). ENS cannot list names by record, but resolvers
 * emit `TextChanged` with the key as an indexed topic, so one topic-filtered
 * eth_getLogs over all contracts finds them with nothing but an Ethereum RPC.
 * The log gives the namehash, not the name; that is enough, because the
 * current record holds the community's public key, and loading the community
 * by key returns its name.
 *
 * Not covered: offchain (CCIP-read) resolvers, which emit no logs.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  type Hex,
} from 'viem';
import { mainnet } from 'viem/chains';
import { normalizeAddress } from '../address.js';

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const TEXT_KEY = 'bitsocial';

/** Both TextChanged shapes: older resolvers omit the value from the event. */
const TEXT_CHANGED_TOPICS = [
  keccak256(toHex('TextChanged(bytes32,string,string)')),
  keccak256(toHex('TextChanged(bytes32,string,string,string)')),
];
/** An indexed string topic is the keccak256 of the string. */
const KEY_TOPIC = keccak256(toHex(TEXT_KEY));

/** Stay this far behind head so a reorg cannot hide a log behind the cursor. */
const CONFIRMATIONS = 12n;
const MIN_RANGE = 500n;
/** Pause between log requests: free endpoints block bursts (rpc.mevblocker.io did after ~40). */
const DEFAULT_PAUSE_MS = 500;

const REGISTRY_ABI = parseAbi(['function resolver(bytes32 node) view returns (address)']);
const RESOLVER_ABI = parseAbi(['function text(bytes32 node, string key) view returns (string)']);

/** What the scan needs from Ethereum; a seam so tests run without a chain. */
export interface EnsChain {
  blockNumber(): Promise<bigint>;
  /** TextChanged logs for the `bitsocial` key in [from, to], from any contract. */
  textChangedLogs(from: bigint, to: bigint): Promise<{ address: Hex; topics: Hex[] }[]>;
  /** The node's current resolver, or the zero address. */
  resolverOf(node: Hex): Promise<Hex>;
  /** The node's current `bitsocial` record on that resolver; throws EnsRevertError if the call reverts. */
  bitsocialText(resolver: Hex, node: Hex): Promise<string>;
}

/** A resolver that cannot answer `text()`: skip the name, it is not an RPC failure. */
export class EnsRevertError extends Error {}

export function viemEnsChain(url: string): EnsChain {
  const client = createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 2, timeout: 30_000 }) });
  return {
    blockNumber: () => client.getBlockNumber(),
    textChangedLogs: async (from, to) =>
      (await client.request({
        method: 'eth_getLogs',
        params: [{ fromBlock: toHex(from), toBlock: toHex(to), topics: [TEXT_CHANGED_TOPICS, null, KEY_TOPIC] }],
      } as never)) as { address: Hex; topics: Hex[] }[],
    resolverOf: (node) =>
      client.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [node] }),
    bitsocialText: async (resolver, node) => {
      try {
        return await client.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'text', args: [node, TEXT_KEY] });
      } catch (err) {
        if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)) {
          throw new EnsRevertError(err.shortMessage);
        }
        throw err;
      }
    },
  };
}

const PUBLIC_KEY = /^(?:12D3KooW[1-9A-HJ-NP-Za-km-z]{44}|k51qzi5uqu5[a-z0-9]{48,52})$/;

/** The IPNS public key a `bitsocial` record points at, or null when it is not one. */
export function parseBitsocialRecord(value: string): string | null {
  const first = value.split(';')[0]?.trim() ?? '';
  return PUBLIC_KEY.test(first) ? normalizeAddress(first) : null;
}

export interface EnsScanOptions {
  chain: EnsChain;
  /** Where to start when no cursor is saved. */
  fromBlock: bigint;
  maxRange: bigint;
  /** Last block already scanned, if any. */
  cursor: bigint | undefined;
  saveCursor(block: bigint): void;
  onRecord(record: { node: Hex; publicKey: string }): void;
  log?: (message: string) => void;
  /** Milliseconds between log requests. */
  pauseMs?: number;
}

/**
 * Scan from the cursor to (head − confirmations). Each block range is fully
 * resolved before the cursor moves past it, so an RPC failure resumes the
 * same range next time instead of losing names. A provider that refuses a
 * span gets half of it, down to MIN_RANGE; the span grows back after success.
 * Returns the number of records reported.
 */
export async function scanEns(opts: EnsScanOptions): Promise<number> {
  const head = (await opts.chain.blockNumber()) - CONFIRMATIONS;
  let from = opts.cursor === undefined ? opts.fromBlock : opts.cursor + 1n;
  let range = opts.maxRange;
  let reported = 0;
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
  let first = true;

  while (from <= head) {
    if (!first && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    first = false;
    const to = from + range - 1n < head ? from + range - 1n : head;
    let logs: { address: Hex; topics: Hex[] }[];
    try {
      logs = await opts.chain.textChangedLogs(from, to);
    } catch (err) {
      if (range <= MIN_RANGE) throw err;
      range = range / 2n > MIN_RANGE ? range / 2n : MIN_RANGE;
      continue;
    }

    // A node's current resolver is the registry's answer, not necessarily the
    // contract that logged: names move resolvers, and old logs stay behind.
    const nodes = new Set(logs.map((l) => l.topics[1]).filter((t): t is Hex => typeof t === 'string'));
    for (const node of nodes) {
      const resolver = await opts.chain.resolverOf(node);
      if (resolver.toLowerCase() === zeroAddress) continue;
      let value: string;
      try {
        value = await opts.chain.bitsocialText(resolver, node);
      } catch (err) {
        if (err instanceof EnsRevertError) continue;
        throw err;
      }
      const publicKey = parseBitsocialRecord(value);
      if (!publicKey) continue;
      opts.onRecord({ node, publicKey });
      reported++;
    }

    opts.saveCursor(to);
    from = to + 1n;
    if (range < opts.maxRange) range = range * 2n < opts.maxRange ? range * 2n : opts.maxRange;
  }
  if (reported) opts.log?.(`[ens] ${reported} bitsocial records up to block ${head}`);
  return reported;
}
