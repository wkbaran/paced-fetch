import { Limiter, type Rate } from "./limiter.js";

/**
 * A fetch that paces requests per API host and retries what's worth retrying.
 *
 * - Before sending: each host's limiter (rate, concurrency, minimum gap).
 * - 429: retried after Retry-After (or a backoff with jitter), and the host is
 *   slowed for the rest of the process. A Retry-After longer than
 *   `maxRetryWaitMs` isn't waited out: the call throws RateLimitedError, and so
 *   does every later call to that host until the block ends.
 * - 5xx and network errors: retried for idempotent requests only.
 * - Anything else, and the last response when retries run out, is returned as
 *   is, so the caller's own error handling still applies.
 *
 * Request bodies must be re-sendable (a string, not a stream) to be retried.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PaceOptions {
  /** At most this many requests started per window, e.g. `{ count: 50, perMs: 5000 }`. */
  rate?: Rate;
  /** At most this many requests in flight. */
  concurrency?: number;
  /** At least this long between request starts. */
  minGapMs?: number;
  /** Retries after the first try (default 3). */
  retries?: number;
  /** Longest Retry-After or backoff worth waiting (default 60 s). */
  maxRetryWaitMs?: number;
  /** Waits without Retry-After, by retry number; the last repeats (default 1 s, 3 s, 10 s). */
  backoffMs?: number[];
}

export interface PaceEvent {
  type: "retry" | "blocked";
  host: string;
  url: string;
  status?: number;
  error?: string;
  waitMs: number;
}

export interface PacedFetchOptions {
  fetch?: FetchLike;
  /** Pacing for every host not named in `hosts`. */
  defaults?: PaceOptions;
  /** Per host: a hostname ("api.deezer.com") or a domain that covers its subdomains ("deezer.com"). */
  hosts?: Record<string, PaceOptions>;
  /** Whether 5xx and network errors may be retried; default: GET, HEAD, OPTIONS, PUT, DELETE. */
  isIdempotent?: (method: string, url: URL) => boolean;
  onEvent?: (e: PaceEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class RateLimitedError extends Error {
  constructor(
    readonly host: string,
    readonly until: Date,
  ) {
    const mins = Math.max(1, Math.round((until.getTime() - Date.now()) / 60_000));
    super(`${host} is rate-limiting requests until ${until.toISOString().slice(0, 16)}Z, about ${mins} min from now.`);
    this.name = "RateLimitedError";
  }
}

export interface PacedFetch extends FetchLike {
  /** The limiter for a host, created on first use. */
  limiter(host: string): Limiter;
}

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

export function pacedFetch(opts: PacedFetchOptions = {}): PacedFetch {
  const base = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const limiters = new Map<string, { limiter: Limiter; pace: PaceOptions }>();

  const forHost = (host: string) => {
    const key = matchHost(host, opts.hosts ?? {});
    const id = key ?? `*${host}`;
    let entry = limiters.get(id);
    if (!entry) {
      // Unnamed hosts each get their own limiter with the default settings.
      const pace = { ...opts.defaults, ...(key ? opts.hosts![key] : {}) };
      entry = { limiter: new Limiter({ ...pace, now, sleep }), pace };
      limiters.set(id, entry);
    }
    return entry;
  };

  const paced = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const idempotent = opts.isIdempotent ? opts.isIdempotent(method, url) : IDEMPOTENT.has(method);
    const { limiter, pace } = forHost(url.hostname);
    const retries = pace.retries ?? 3;
    const maxWait = pace.maxRetryWaitMs ?? 60_000;
    const backoff = pace.backoffMs ?? [1000, 3000, 10_000];
    const jittered = (attempt: number) => Math.round(backoff[Math.min(attempt, backoff.length - 1)]! * (1 + 0.3 * random()));

    for (let attempt = 0; ; attempt++) {
      if (limiter.blockedUntil > now()) throw new RateLimitedError(url.hostname, new Date(limiter.blockedUntil));
      const release = await limiter.acquire();
      let res: Response;
      try {
        res = await base(input, init);
      } catch (err) {
        release();
        if (!idempotent || attempt >= retries || isAbort(err)) throw err;
        const waitMs = jittered(attempt);
        opts.onEvent?.({ type: "retry", host: url.hostname, url: url.href, error: err instanceof Error ? err.message : String(err), waitMs });
        await sleep(waitMs);
        continue;
      }
      release();

      const is429 = res.status === 429;
      if (res.ok) limiter.succeeded();
      if (!is429 && !(res.status >= 500 && idempotent)) return res;
      const waitMs = retryAfterMs(res, now()) ?? jittered(attempt);
      if (is429) limiter.slowDown();
      if (waitMs > maxWait) {
        if (!is429) return res;
        limiter.blockedUntil = now() + waitMs;
        opts.onEvent?.({ type: "blocked", host: url.hostname, url: url.href, status: 429, waitMs });
        await res.body?.cancel().catch(() => {});
        throw new RateLimitedError(url.hostname, new Date(limiter.blockedUntil));
      }
      if (attempt >= retries) return res;
      opts.onEvent?.({ type: "retry", host: url.hostname, url: url.href, status: res.status, waitMs });
      await res.body?.cancel().catch(() => {});
      await sleep(waitMs);
    }
  }) as PacedFetch;
  paced.limiter = (host) => forHost(host).limiter;
  return paced;
}

/** The `hosts` key covering a hostname: an exact match, else the longest domain it's under. */
export function matchHost(host: string, hosts: Record<string, unknown>): string | undefined {
  const h = host.toLowerCase();
  let best: string | undefined;
  for (const key of Object.keys(hosts)) {
    const k = key.toLowerCase().replace(/^\*?\./, "");
    if ((h === k || h.endsWith(`.${k}`)) && (!best || k.length > best.length)) best = key;
  }
  return best;
}

/** Retry-After as milliseconds from now: delta seconds or an HTTP date. */
export function retryAfterMs(res: Response, now = Date.now()): number | null {
  const value = res.headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}
