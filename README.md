# bitsocial-discovery

Finds [Bitsocial](https://bitsocial.net) communities that no list has
carried yet, checks which ones are alive, and serves what it found as a JSON
API that clients, indexers and review tools can read.

Bitsocial has no global community index: a client opens any community whose
address it knows, and today the known addresses come from hand-maintained
lists. This service starts from those lists (or anything else you give it)
and follows the pointers communities leave to each other.

> **It ships idle.** With nothing configured to start from, it does nothing.
> The operator chooses the sources, and decides what the API shows.

## How it finds communities

| Source | Config | What it reads |
|---|---|---|
| Seeds | `SEEDS`, `SEEDS_SOURCES` | Addresses, or JSON lists such as [`bitsocialnet/lists`](https://github.com/bitsocialnet/lists) files |
| Submissions | `SUBMISSIONS_SOURCE` | A JSON list of addresses people sent the operator |
| Indexers | `INDEXER_URLS` | A [bitsocial-indexer](https://github.com/bitsocialnet/bitsocial-indexer) API: its communities, and the signed comments it archived |
| ENS | `ETH_RPC_URL` | Every ENS name whose resolver ever set a `bitsocial` text record (how `.bso` names resolve) |
| Mentions | always on | Addresses written in community descriptions, rules, post titles, bodies and links |
| Crossposts | always on | The community of every crossposted original |
| Author chains | `AUTHOR_CHAIN_DEPTH` | `author.previousCommentCid`: an author's previous comment, often in another community |

The last three run on every community that resolves, using its record and the
first page of posts the record already carries. Every address found becomes a
candidate; candidates that resolve are checked again every
`RECHECK_INTERVAL_MS`, and ones that fail back off exponentially. Discovery
keeps growing as communities link to each other, and keeps track of which
ones are still alive.

Discovery stores community metadata (title, description, owner-declared
features) and how each address was found. It never stores posts.

Limits worth knowing:

- Pseudonymous communities (every 5chan board) strip author data, so author
  chains never pass through them. 5chan boards are found through ENS,
  mentions, crossposts and submissions.
- Author chains only work when clients put `author.previousCommentCid` on
  new comments.
- The ENS scan sees only resolvers that emit `TextChanged` logs; offchain
  (CCIP-read) resolvers do not.
- An author's address mentioned in a post looks like a community address. It
  is checked like any candidate and backs off once it fails to resolve.

## Fetch-only node

Every candidate is fetched through `PKC_RPC_URL`, and candidates are by
definition communities nobody has reviewed. A normal IPFS node keeps what it
fetches and serves it to other peers, so **pointing discovery at a node that
also hosts or seeds communities makes that node redistribute whatever
discovery fetched**, illegal content included.

Run a separate `bitsocial-cli` daemon for discovery and turn kubo into a
client-only node before its first fetch. Start it once to create its repo,
stop it, then set in `<data path>/.bitsocial-cli.ipfs/config` (kubo ≥ 0.36):

```json
{
  "Bitswap": { "ServerEnabled": false },
  "Provide": { "Enabled": false }
}
```

`Bitswap.ServerEnabled=false` answers "don't have" to every block request;
`Provide.Enabled=false` stops announcing blocks to the routing system.
bitsocial-cli keeps both settings across restarts. Check them on the running
node:

```bash
curl -s -X POST "http://127.0.0.1:50019/api/v0/config?arg=Bitswap.ServerEnabled"
```

## Quickstart

```bash
npm ci --legacy-peer-deps
SEEDS_SOURCES=https://raw.githubusercontent.com/bitsocialnet/lists/master/seedit-default-subscriptions.json \
PKC_RPC_URL=ws://localhost:9138 \
npm run dev
curl -s http://127.0.0.1:4100/api/communities
```

Docker: `docker-compose.yml` runs the published image
(`ghcr.io/bitsocialnet/bitsocial-discovery`), with the API bound to the host's
loopback.

## Configuration

All configuration is environment variables; [`.env.example`](.env.example)
lists every one with its default.

| Var | Default | Meaning |
|---|---|---|
| `PKC_RPC_URL` | `ws://localhost:9138` | The fetch-only daemon's PKC RPC endpoint |
| `SEEDS` | _(empty)_ | Comma-separated addresses to start from |
| `SEEDS_SOURCES` | _(empty)_ | Comma-separated URLs/paths of JSON lists: `["a.bso", …]`, `{ "communities": [...] }` or `{ "boards": [...] }`; entries' `address` and `publicKey` are both used |
| `SUBMISSIONS_SOURCE` | _(empty)_ | Same format; recorded as `submission` |
| `INDEXER_URLS` | _(empty)_ | Comma-separated bitsocial-indexer API base URLs |
| `ETH_RPC_URL` | _(empty)_ | Ethereum JSON-RPC for the ENS scan; empty = no scan |
| `ENS_FROM_BLOCK` | `23085558` | First block scanned when no cursor is saved |
| `ENS_MAX_BLOCK_RANGE` | `50000` | Largest `eth_getLogs` span; halves on its own when refused |
| `SOURCES_REFRESH_MS` | `3600000` | How often every source is read again |
| `CHECK_CONCURRENCY` | `2` | Communities fetched at once |
| `CHECK_TIMEOUT_MS` | `120000` | Cap on one check, author-chain hops included |
| `RECHECK_INTERVAL_MS` | `21600000` | Wait before a resolved community is checked again |
| `RETRY_MIN_MS` / `RETRY_MAX_MS` | 15 min / 7 days | Backoff bounds after failed checks |
| `AUTHOR_CHAIN_DEPTH` | `3` | `previousCommentCid` hops followed per comment; `0` turns chains off |
| `MAX_CHAINS_PER_CHECK` | `50` | Chains started per community check |
| `OVERRIDES_SOURCE` | _(empty)_ | The operator review file (below) |
| `PUBLIC_LISTING` | `all` | `all`: every resolved community not hidden or blocked. `reviewed`: only `approved` and `listed` |
| `ADMIN_TOKEN` | _(empty)_ | Bearer token that sees everything, including `/api/candidates` |
| `PORT` / `HOST` | `4100` / `127.0.0.1` | API listen address |
| `ALLOWED_ORIGINS` | `*` | CORS allow-list, same syntax as bitsocial-indexer |
| `DB_PATH` | `./data/discovery.db` | SQLite file |

### ENS

The scan asks for `TextChanged` logs whose key topic is `bitsocial`, from any
contract, then reads each name's current record from its current resolver.
It needs only an Ethereum RPC, but the RPC has to accept topic-only
`eth_getLogs` over thousands of blocks. As of 2026-10-27: `rpc.mevblocker.io`
accepted 50,000-block spans; `eth.drpc.org`'s public tier was rate-limited;
`ethereum-rpc.publicnode.com` requires an `address` filter; `1rpc.io` caps
spans at 50 blocks. A paid or self-hosted endpoint is the reliable choice.
The first scan reads from `ENS_FROM_BLOCK` to head; later scans resume from
the saved cursor.

## Operator review file

Discovery finds communities nobody has looked at. `OVERRIDES_SOURCE` is how
an operator records what they decided, by any address a community has (name,
key, or an alias it was found under):

```json
[
  { "address": "memes.bso", "status": "approved" },
  { "address": "12D3KooW…", "status": "listed", "nsfw": true },
  { "address": "spam.bso", "status": "hidden", "reason": "spam" },
  { "address": "12D3KooW…", "status": "blocked", "reason": "report 2026-11-02" }
]
```

| Status | Shown publicly | Fetched again | Harvested |
|---|---|---|---|
| `approved` (content checked) | yes | yes | yes |
| `listed` (title/description checked) | yes | yes | yes |
| _(none)_ = `unreviewed` | only with `PUBLIC_LISTING=all` | yes | yes |
| `hidden` | no | yes | yes |
| `blocked` | no | no, once its key is known | no |

When aliases of one community disagree, the strictest status wins. `nsfw`
overrides the owner's `features.safeForWork`. `reason` is only returned to
admin requests. The file is re-read whenever it changes.

## API

CORS-enabled, read-only.

| Endpoint | Description |
|---|---|
| `GET /api/health` | Counts, last source refresh, ENS cursor |
| `GET /api/communities` | Resolved communities. `sort=new\|updated\|created\|title` (`new` = first resolved by this instance), `review=approved,listed,unreviewed`, `pseudonymous=true\|false`, `nsfw=true\|false`, `uiType` (default leaves out `author` profiles; `any` = all), `limit` + `page` (no `limit` = everything) |
| `GET /api/communities/:address` | One community, by name, key or alias |
| `GET /api/candidates` | Admin only: every known address with its check state, error and sources |

Each community carries `address`, `publicKey`, `name`, `aliases`, `title`,
`description`, `createdAt`, `updatedAt`, `firstSeenAt`, `lastResolvedAt`,
`pseudonymityMode`, `safeForWork`, `uiType`, `review`, `nsfw`
(`true`/`false`/`null`) and `sources` (`type`, `via`, `firstSeenAt`).

### Feeding an indexer

`GET /api/communities` without `limit` returns `{ "communities": [{ "address": … }] }`,
the shape bitsocial-indexer reads from `COMMUNITIES_SOURCE`, so a filtered URL
can drive an archive directly, for example only reviewed, non-pseudonymous
communities:

```
COMMUNITIES_SOURCE=http://127.0.0.1:4100/api/communities?review=approved&pseudonymous=false
```

## Development

```bash
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
