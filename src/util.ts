/** Helpers shared with bitsocial-indexer's crawler (server/src/crawler/crawler.ts). */

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Reject if `promise` has not settled within `ms`. PKC calls have no bound of
 * their own; one that never settles would otherwise hold a worker forever.
 */
export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Run every item with a fixed worker pool, preserving a hard concurrency cap. */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  let next = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await worker(item);
      }
    }),
  );
}

const MAX_ERROR_LENGTH = 300;

/**
 * One line for a log. viem errors put the useful part (the provider's own
 * message) in `details` and a generic line in `shortMessage`, so show both.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, MAX_ERROR_LENGTH);
  const { shortMessage, details } = err as { shortMessage?: unknown; details?: unknown };
  const message =
    typeof shortMessage === 'string' && typeof details === 'string' && details ? `${shortMessage} (${details})` : err.message;
  // A provider's HTML error page (a Cloudflare block, say) is useless past its title.
  const oneLine = message.replace(/\s+/g, ' ');
  return oneLine.length > MAX_ERROR_LENGTH ? `${oneLine.slice(0, MAX_ERROR_LENGTH)}…` : oneLine;
}
