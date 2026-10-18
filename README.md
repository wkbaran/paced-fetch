# paced-fetch

A `fetch` that is polite to the APIs it calls. Each API host gets a limiter (requests per window, requests in flight, a minimum gap), 429s are waited out the way the server asks, and every program that uses it is configured with the same environment variables.

It was written for MCP servers that read web APIs (Substack, Medium, Spotify, Deezer…), each of which had grown its own retry loop with its own rules. No dependencies.

```ts
import { pacedFetch, paceFromEnv } from "paced-fetch";

const { pace, warnings } = paceFromEnv("SUBSTACK", { concurrency: 3 }); // env over these defaults
const fetch = pacedFetch({
  defaults: pace,
  hosts: { "deezer.com": { rate: { count: 50, perMs: 5000 } } }, // Deezer's documented limit
  onEvent: (e) => console.error(`${e.type} ${e.host} ${e.status ?? e.error} (waiting ${e.waitMs} ms)`),
});
const res = await fetch("https://example.substack.com/api/v1/archive");
```

## What it does

| Situation | Behavior |
|---|---|
| Before each request | Waits for the host's limiter: `concurrency`, `rate` (sliding window), `minGapMs` |
| 429 | Retries after `Retry-After` (seconds or a date), else a backoff with jitter (1 s, 3 s, 10 s). Also widens that host's gap (250 ms, doubling to 10 s); every 20 successes in a row halve it again |
| 429 with a wait longer than `maxRetryWaitMs` | Doesn't wait: throws `RateLimitedError` (with `until`), and every later call to that host throws at once until then, without sending anything |
| 5xx, network error | Retried for idempotent requests only (GET, HEAD, OPTIONS, PUT, DELETE, or what `isIdempotent` says, e.g. GraphQL reads) |
| Anything else, or retries run out | The response is returned as is, so the caller's own error handling still runs |

`timeoutMs` times out each attempt from when it's actually sent, and such a timeout is retried like a network error. A timeout or abort from the caller's own `signal` is never retried, and it also counts time spent waiting for the limiter, so prefer `timeoutMs`. Request bodies are sent again on a retry, so pass strings, not streams.

Hosts not named in `hosts` each get their own limiter with the `defaults`. A `hosts` key is a hostname, or a domain that covers its subdomains (`deezer.com` covers `api.deezer.com`).

## Environment variables

`paceFromEnv(prefix, defaults)` reads these over the program's defaults:

| Variable | Example | |
|---|---|---|
| `<PREFIX>_RATE` | `60/min`, `10/s`, `50/5s` | Requests started per window |
| `<PREFIX>_CONCURRENCY` | `3` | Requests in flight |
| `<PREFIX>_MIN_GAP` | `250ms` | Between request starts |
| `<PREFIX>_RETRIES` | `3` | Retries after the first try |
| `<PREFIX>_MAX_RETRY_WAIT` | `60s`, `5min` | Longest wait worth sitting through |

`off` (or `0`) removes a rate, concurrency or gap limit. A value that doesn't parse is ignored and listed in `warnings`, so a typo doesn't stop a server from starting.

## Development

```sh
npm install
npm test
```

Node 26 or later. MIT licensed.
