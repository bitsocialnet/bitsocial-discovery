import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isAddress, normalizeAddress } from '../address.js';
import { config } from '../config.js';
import { counts, getState, recordSubmission } from '../db/index.js';
import { lastSourcesRefreshAt } from '../discover.js';
import { REVIEW_STATUSES } from '../overrides.js';
import { nowSec } from '../util.js';
import { candidateViews, communityViews, type CommunityView, type Review } from './view.js';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ALLOWED_ORIGINS as @fastify/cors expects it; same rules as bitsocial-indexer. */
export function parseAllowedOrigins(value: string): true | (string | RegExp)[] {
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.includes('*')) return true;
  return entries.map((entry) =>
    entry.includes('*') ? new RegExp(`^${entry.split('*').map(escapeRegExp).join('[^/]*')}$`) : entry,
  );
}

/** True when the request carries ADMIN_TOKEN as a bearer token. */
export function isAdmin(req: FastifyRequest): boolean {
  if (!config.adminToken) return false;
  const header = req.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${config.adminToken}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const SORTS = {
  new: (a: CommunityView, b: CommunityView) => b.firstSeenAt - a.firstSeenAt,
  updated: (a: CommunityView, b: CommunityView) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1),
  created: (a: CommunityView, b: CommunityView) => (b.createdAt ?? -1) - (a.createdAt ?? -1),
  title: (a: CommunityView, b: CommunityView) => (a.title ?? a.address).localeCompare(b.title ?? b.address),
} as const;

interface ListQuery {
  sort: keyof typeof SORTS;
  review?: string;
  pseudonymous?: boolean;
  nsfw?: boolean;
  uiType?: string;
  limit?: number;
  page: number;
}

const listQuerySchema = {
  type: 'object',
  properties: {
    sort: { type: 'string', enum: Object.keys(SORTS), default: 'new' },
    review: { type: 'string' },
    pseudonymous: { type: 'boolean' },
    nsfw: { type: 'boolean' },
    uiType: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    page: { type: 'integer', minimum: 1, default: 1 },
  },
} as const;

const submissionBodySchema = {
  type: 'object',
  required: ['address'],
  properties: { address: { type: 'string', maxLength: 128 } },
} as const;

/** `review=approved,listed` → the set of statuses to keep, or an error. */
function parseReviewFilter(value: string | undefined, admin: boolean): Set<Review> | string | null {
  if (value === undefined) return null;
  const allowed: Review[] = admin ? [...REVIEW_STATUSES, 'unreviewed'] : ['approved', 'listed', 'unreviewed'];
  const wanted = value.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((s) => !(allowed as string[]).includes(s));
  if (unknown.length) return `unknown review status: ${unknown.join(', ')}`;
  return new Set(wanted as Review[]);
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cors, {
    origin: parseAllowedOrigins(config.allowedOrigins),
    methods: ['GET', 'HEAD', 'POST'],
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    ...counts(),
    lastSourcesRefreshAt: lastSourcesRefreshAt(),
    ensCursor: getState('ens:cursor') ?? null,
  }));

  /**
   * Resolved communities. Profiles (`suggested.uiType: "author"`) are left out
   * unless `uiType` asks for them (`uiType=any` for everything). Without
   * `limit` the whole list is returned, so the URL works as an indexer's
   * COMMUNITIES_SOURCE.
   */
  app.get('/api/communities', { schema: { querystring: listQuerySchema } }, async (req, reply) => {
    const q = req.query as ListQuery;
    const admin = isAdmin(req);
    const review = parseReviewFilter(q.review, admin);
    if (typeof review === 'string') return reply.code(400).send({ error: review });

    const matches = communityViews(admin).filter(
      (c) =>
        (q.uiType === 'any' || (q.uiType === undefined ? c.uiType !== 'author' : c.uiType === q.uiType)) &&
        (!review || review.has(c.review)) &&
        (q.pseudonymous === undefined || Boolean(c.pseudonymityMode) === q.pseudonymous) &&
        (q.nsfw === undefined || (c.nsfw === true) === q.nsfw),
    );
    matches.sort(SORTS[q.sort]);
    const page = q.limit ? matches.slice((q.page - 1) * q.limit, q.page * q.limit) : matches;
    return { communities: page, total: matches.length };
  });

  app.get('/api/communities/:address', async (req, reply) => {
    const wanted = normalizeAddress((req.params as { address: string }).address);
    const match = communityViews(isAdmin(req)).find(
      (c) => c.address === wanted || c.publicKey === wanted || c.name === wanted || c.aliases.includes(wanted),
    );
    if (!match) return reply.code(404).send({ error: 'community not found' });
    return match;
  });

  /** Every known address with its check state and sources. Admin only. */
  app.get('/api/candidates', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: 'admin token required' });
    const candidates = candidateViews();
    return { candidates, total: candidates.length };
  });

  /**
   * Anyone can propose an address, such as a community with no name that
   * nothing links to yet. It becomes an ordinary candidate: listed once it
   * resolves, and subject to the review file. Off unless SUBMISSIONS_PER_HOUR
   * is set.
   */
  if (config.submissionsPerHour > 0) {
    app.post('/api/submissions', { bodyLimit: 1024, schema: { body: submissionBodySchema } }, async (req, reply) => {
      const raw = (req.body as { address: string }).address;
      if (!isAddress(raw)) {
        return reply.code(400).send({ error: 'expected a .bso or .eth name, or an IPNS public key' });
      }
      const address = normalizeAddress(raw);
      const result = recordSubmission(address, nowSec(), config.submissionsPerHour);
      if (!result.accepted) {
        return reply
          .code(429)
          .header('retry-after', String(result.retryAfter))
          .send({ error: 'too many submissions this hour, try again later' });
      }
      // The same answer for new and known addresses, so it reveals nothing the list hides.
      return reply.code(202).send({ address });
    });
  }

  return app;
}
