# bitsocial-discovery agent notes

Node 22, TypeScript ESM, Fastify 5, better-sqlite3, pkc-js over PKC RPC, viem for ENS. Install with `npm ci --legacy-peer-deps` (same reason as bitsocial-indexer: pkc-js has a React Native peer that a Node-only client never uses). Relock with npm 10 (`npx npm@10.9.9 install --legacy-peer-deps`), which CI's Node 22 uses; an npm 11 lockfile can fail `npm ci` there.

## Checks

Run `npm run typecheck`, `npm test` and `npm run build` before pushing. Tests use node:test through tsx against an in-memory SQLite database (`DB_PATH=:memory:` in the test script) and fake PKC/ENS/fetch seams (`setDepsForTest`, `EnsChain`, injected `fetch`); none touch the network.

## Rules that are easy to break

- Never point `PKC_RPC_URL` at a node that hosts or seeds communities, in production or while testing. Discovery fetches communities nobody has reviewed, and a normal kubo node serves what it fetched. Smoke tests use a throwaway `bitsocial-cli` daemon with `Bitswap.ServerEnabled=false` and `Provide.Enabled=false` (README, "Fetch-only node"), and its data directory is deleted afterwards.
- Discovery stores community metadata and provenance, never posts. Keep it that way.
- A `blocked` override must stop fetching and harvesting, not just hide the row.
- `GET /api/communities` without `limit` must keep returning the whole list in the `{ communities: [{ address }] }` shape: bitsocial-indexer reads it as `COMMUNITIES_SOURCE`.
- The PKC client in `src/pkc/client.ts` is shared with bitsocial-indexer (`server/src/pkc/client.ts`); port fixes both ways.
