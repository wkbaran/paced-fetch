import type { PaceOptions } from "./fetch.js";
import type { Rate } from "./limiter.js";

/**
 * Pacing from environment variables with a common prefix, over a server's own
 * defaults:
 *
 *   <PREFIX>_RATE=60/min          (or 10/s, 50/5s, 1000/h)
 *   <PREFIX>_CONCURRENCY=3
 *   <PREFIX>_MIN_GAP=250ms        (ms, s, min)
 *   <PREFIX>_RETRIES=3
 *   <PREFIX>_MAX_RETRY_WAIT=60s
 *
 * `off` or `0` for RATE, CONCURRENCY or MIN_GAP removes that limit. A value
 * that doesn't parse is ignored and reported in `warnings`, so a typo never
 * stops a server from starting.
 */
export function paceFromEnv(prefix: string, defaults: PaceOptions = {}, env: NodeJS.ProcessEnv = process.env): { pace: PaceOptions; warnings: string[] } {
  const pace: PaceOptions = { ...defaults };
  const warnings: string[] = [];
  const read = <T>(name: string, parse: (v: string) => T | null | undefined, apply: (v: T | null) => void) => {
    const raw = env[`${prefix}_${name}`]?.trim();
    if (!raw) return;
    if (/^(off|none|0)$/i.test(raw) && name !== "RETRIES") return apply(null);
    const v = parse(raw);
    if (v === undefined || v === null) warnings.push(`${prefix}_${name}=${raw} isn't valid; using the default.`);
    else apply(v);
  };
  read("RATE", parseRate, (v) => (v ? (pace.rate = v) : delete pace.rate));
  read("CONCURRENCY", positiveInt, (v) => (v ? (pace.concurrency = v) : delete pace.concurrency));
  read("MIN_GAP", parseDuration, (v) => (v ? (pace.minGapMs = v) : delete pace.minGapMs));
  read("RETRIES", (s) => (/^\d+$/.test(s) ? Number(s) : null), (v) => v !== null && (pace.retries = v));
  read("MAX_RETRY_WAIT", parseDuration, (v) => v !== null && (pace.maxRetryWaitMs = v));
  return { pace, warnings };
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000 };

/** "60/min", "10/s", "50/5s", "1000/h". */
export function parseRate(s: string): Rate | null {
  const m = /^\s*(\d+)\s*\/\s*(\d*(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(s);
  if (!m) return null;
  const unit = UNITS[m[3]!.toLowerCase()];
  const count = Number(m[1]);
  const n = m[2] ? Number(m[2]) : 1;
  if (!unit || !count || !n) return null;
  return { count, perMs: n * unit };
}

/** "250ms", "2s", "1.5 min", or a bare number of milliseconds. */
export function parseDuration(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(s);
  if (!m) return null;
  const unit = m[2] ? UNITS[m[2].toLowerCase()] : 1;
  return unit ? Math.round(Number(m[1]) * unit) : null;
}

function positiveInt(s: string): number | null {
  return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null;
}
