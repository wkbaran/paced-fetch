import { describe, expect, it } from "vitest";
import { matchHost, pacedFetch, paceFromEnv, parseDuration, parseRate, RateLimitedError, type FetchLike, type PaceEvent } from "../src/index.js";

/** A clock that only moves when someone sleeps. */
function clock() {
  const c = {
    t: 1_000_000,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
}

function script(answers: (number | [number, Record<string, string>] | Error)[]) {
  const sent: { url: string; method: string; at: number }[] = [];
  let i = 0;
  const make = (c: { now: () => number }): FetchLike =>
    async (input, init) => {
      sent.push({ url: String(input), method: init?.method ?? "GET", at: c.now() });
      const a = answers[Math.min(i++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      const [status, headers] = Array.isArray(a) ? a : [a, {}];
      return new Response(status === 204 ? null : "body", { status, headers });
    };
  return { sent, make };
}

describe("pacing", () => {
  it("keeps to the rate window and the minimum gap", async () => {
    const c = clock();
    const s = script([200]);
    const f = pacedFetch({ fetch: s.make(c), defaults: { rate: { count: 2, perMs: 1000 }, minGapMs: 100 }, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 5; i++) await f("https://api.example.com/x");
    expect(s.sent.map((r) => r.at - 1_000_000)).toEqual([0, 100, 1000, 1100, 2000]);
  });

  it("caps requests in flight", async () => {
    let active = 0;
    let peak = 0;
    const base: FetchLike = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response("ok");
    };
    const f = pacedFetch({ fetch: base, defaults: { concurrency: 2 } });
    await Promise.all(Array.from({ length: 6 }, () => f("https://a.example.com/")));
    expect(peak).toBe(2);
  });

  it("gives each host its own limiter, and lets a domain key cover subdomains", async () => {
    const c = clock();
    const s = script([200]);
    const f = pacedFetch({ fetch: s.make(c), defaults: { minGapMs: 1000 }, hosts: { "deezer.com": { minGapMs: 0 } }, now: c.now, sleep: c.sleep });
    await f("https://one.example.com/");
    await f("https://two.example.com/");
    await f("https://api.deezer.com/a");
    await f("https://api.deezer.com/b");
    expect(s.sent.map((r) => r.at - 1_000_000)).toEqual([0, 0, 0, 0]);
    expect(matchHost("api.deezer.com", { "deezer.com": 1, "api.deezer.com": 2 })).toBe("api.deezer.com");
    expect(matchHost("notdeezer.com", { "deezer.com": 1 })).toBeUndefined();
  });
});

describe("retries", () => {
  it("waits out a 429's Retry-After, then slows the host down", async () => {
    const c = clock();
    const s = script([[429, { "retry-after": "2" }], 200, 200]);
    const events: PaceEvent[] = [];
    const f = pacedFetch({ fetch: s.make(c), now: c.now, sleep: c.sleep, onEvent: (e) => events.push(e) });
    expect((await f("https://api.example.com/x")).status).toBe(200);
    await f("https://api.example.com/y");
    expect(s.sent.map((r) => r.at - 1_000_000)).toEqual([0, 2000, 2250]);
    expect(events).toMatchObject([{ type: "retry", status: 429, waitMs: 2000 }]);
    expect(f.limiter("api.example.com").extraGapMs).toBe(250);
    for (let i = 0; i < 19; i++) await f("https://api.example.com/z");
    expect(f.limiter("api.example.com").extraGapMs).toBe(0);
  });

  it("returns the last response when retries run out", async () => {
    const c = clock();
    const s = script([503]);
    const f = pacedFetch({ fetch: s.make(c), defaults: { retries: 2 }, now: c.now, sleep: c.sleep, random: () => 0 });
    expect((await f("https://api.example.com/x")).status).toBe(503);
    expect(s.sent.map((r) => r.at - 1_000_000)).toEqual([0, 1000, 4000]);
  });

  it("doesn't retry a POST after a 5xx or network error, but does after a 429", async () => {
    const c = clock();
    const s = script([500, new TypeError("fetch failed"), 429, 200]);
    const f = pacedFetch({ fetch: s.make(c), now: c.now, sleep: c.sleep });
    expect((await f("https://api.example.com/", { method: "POST", body: "{}" })).status).toBe(500);
    await expect(f("https://api.example.com/", { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
    expect((await f("https://api.example.com/", { method: "POST", body: "{}" })).status).toBe(200);
  });

  it("lets the caller say which requests are safe to retry (e.g. GraphQL reads)", async () => {
    const c = clock();
    const s = script([502, 200]);
    const f = pacedFetch({ fetch: s.make(c), isIdempotent: (m, u) => m === "GET" || u.pathname === "/graphql", now: c.now, sleep: c.sleep });
    expect((await f("https://api.example.com/graphql", { method: "POST", body: "{}" })).status).toBe(200);
  });

  it("retries a network error on a GET", async () => {
    const c = clock();
    const s = script([new TypeError("ECONNRESET"), 200]);
    const f = pacedFetch({ fetch: s.make(c), now: c.now, sleep: c.sleep });
    expect((await f("https://api.example.com/")).status).toBe(200);
  });

  it("fails fast on a Retry-After past the cap, and blocks the host until it ends", async () => {
    const c = clock();
    const s = script([[429, { "retry-after": "3600" }], 200]);
    const f = pacedFetch({ fetch: s.make(c), defaults: { maxRetryWaitMs: 60_000 }, now: c.now, sleep: c.sleep });
    const err = await f("https://api.example.com/a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).until.getTime()).toBe(1_000_000 + 3_600_000);
    await expect(f("https://api.example.com/b")).rejects.toBeInstanceOf(RateLimitedError);
    expect(s.sent).toHaveLength(1);
    c.t += 3_600_000;
    expect((await f("https://api.example.com/c")).status).toBe(200);
    // Other hosts aren't affected.
    expect((await f("https://other.example.com/")).status).toBe(200);
  });
});

describe("paceFromEnv", () => {
  it("reads the common variables over the server's defaults", () => {
    const { pace, warnings } = paceFromEnv(
      "SUBSTACK",
      { concurrency: 3, minGapMs: 100 },
      { SUBSTACK_RATE: "60/min", SUBSTACK_CONCURRENCY: "2", SUBSTACK_MIN_GAP: "off", SUBSTACK_RETRIES: "0", SUBSTACK_MAX_RETRY_WAIT: "2min", SUBSTACK_OTHER: "x" },
    );
    expect(pace).toEqual({ concurrency: 2, rate: { count: 60, perMs: 60_000 }, retries: 0, maxRetryWaitMs: 120_000 });
    expect(warnings).toEqual([]);
  });

  it("ignores and reports a value that doesn't parse", () => {
    const { pace, warnings } = paceFromEnv("X", { concurrency: 3 }, { X_CONCURRENCY: "lots", X_RATE: "fast" });
    expect(pace).toEqual({ concurrency: 3 });
    expect(warnings).toEqual(["X_RATE=fast isn't valid; using the default.", "X_CONCURRENCY=lots isn't valid; using the default."]);
  });

  it("parses rates and durations", () => {
    expect(parseRate("50/5s")).toEqual({ count: 50, perMs: 5000 });
    expect(parseRate("1000/h")).toEqual({ count: 1000, perMs: 3_600_000 });
    expect(parseRate("10 per second")).toBeNull();
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("1.5 min")).toBe(90_000);
    expect(parseDuration("500")).toBe(500);
    expect(parseDuration("2 weeks")).toBeNull();
  });
});
