/**
 * Prompt-cache bookkeeping for a Claude Code session, from the `message.usage` of its answers.
 *
 * The counts are what the transcript recorded; the time left is an estimate, because Anthropic
 * does not report when a cache entry expires. Every request, read or write, refreshes the entry,
 * and the entry lives as long as the last request that wrote one asked for: an hour when it wrote
 * `ephemeral_1h` tokens, five minutes when it wrote `ephemeral_5m` ones.
 *
 * Pure: the server folds requests into a `CacheThread` as it reads a transcript, and the browser
 * reads the thread against its own clock (`cacheLeftMs`), so the chip ticks with no polling.
 */

export const CACHE_TTL_5M_MS = 5 * 60_000;
export const CACHE_TTL_1H_MS = 60 * 60_000;
/** a request after the first that writes at least this much and reads back less than it wrote broke the cache */
export const CACHE_MISS_MIN_WRITE = 10_000;
/** how many of the latest requests the popover lists */
export const CACHE_RECENT = 5;
/** a thread with no write seen yet: the main session defaults to the long lifetime, a subagent to the short one */
export const CACHE_DEFAULT_TTL_MAIN_MS = CACHE_TTL_1H_MS;
export const CACHE_DEFAULT_TTL_SUBAGENT_MS = CACHE_TTL_5M_MS;
/** a chip is green above this many minutes left, yellow below it down to the cold mark */
export const CACHE_GREEN_ABOVE_MS = 15 * 60_000;

/** One request as the popover lists it: what its prompt held, what it read from the cache and what it wrote. */
export interface CacheRecent {
  /** input + cache read + cache write: the whole prompt */
  prompt: number;
  read: number;
  write: number;
  /** `miss`: written (at least CACHE_MISS_MIN_WRITE) and read back less than was written, after a first request */
  miss: boolean;
}

/** What one thread (the main session, or one subagent) did with the cache so far. Times are epoch milliseconds. */
export interface CacheThread {
  requests: number;
  input: number;
  cache_read: number;
  cache_write: number;
  /** when its latest request was written; null before any */
  last_at: number | null;
  /** the lifetime its latest cache write asked for; null while it wrote none, and the reader's default stands */
  ttl_ms: number | null;
  /** the whole prompt of its latest request: what a cold cache rewrites */
  last_prompt: number;
  /** its latest requests, oldest first, at most CACHE_RECENT */
  recent: CacheRecent[];
  /** the id of the latest request: one request is written as one entry per content block, all with its usage */
  last_id: string | null;
}

/** One subagent of the session, by what Ovis labels it elsewhere. */
export interface CacheAgent {
  id: string;
  title: string;
  thread: CacheThread;
}

/** The cache of a session: its main thread, and its subagents (most recent first). */
export interface CacheSummary {
  main: CacheThread;
  subagents?: CacheAgent[];
}

/** What one request used of the cache, as `message.usage` states it. */
export interface CacheUsage {
  input: number;
  read: number;
  write: number;
  /** the lifetime it wrote at, when it wrote anything and said which */
  ttl_ms: number | null;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export function emptyCacheThread(): CacheThread {
  return { requests: 0, input: 0, cache_read: 0, cache_write: 0, last_at: null, ttl_ms: null, last_prompt: 0, recent: [], last_id: null };
}

/**
 * The cache figures of one `message.usage`, or null when it holds none (a synthetic answer reads and
 * writes nothing). The lifetime comes from the breakdown of the write: any `ephemeral_1h` tokens
 * mean the hour (its prefix outlives the five-minute tail), else `ephemeral_5m` tokens mean five
 * minutes. A write with no breakdown says nothing of its lifetime.
 */
export function cacheUsageOf(usage: unknown): CacheUsage | null {
  const used = record(usage);
  const input = count(used["input_tokens"]);
  const read = count(used["cache_read_input_tokens"]);
  const write = count(used["cache_creation_input_tokens"]);
  if (input + read + write === 0) return null;
  const made = record(used["cache_creation"]);
  const hour = count(made["ephemeral_1h_input_tokens"]);
  const five = count(made["ephemeral_5m_input_tokens"]);
  const ttl_ms = write === 0 ? null : hour > 0 ? CACHE_TTL_1H_MS : five > 0 ? CACHE_TTL_5M_MS : null;
  return { input, read, write, ttl_ms };
}

/**
 * The thread after one more request. `id` is the answer's message id: an entry that repeats the id of
 * the latest request is another block of it and counts nothing. A request earlier than the latest one
 * (a file read out of order) is counted but does not move the clock back.
 */
export function addCacheRequest(before: CacheThread | undefined, request: { id: string | null; at: number | null; usage: CacheUsage }): CacheThread {
  const thread = before ?? emptyCacheThread();
  if (request.id !== null && request.id === thread.last_id) return thread;
  const { input, read, write, ttl_ms } = request.usage;
  const miss = thread.requests > 0 && write >= CACHE_MISS_MIN_WRITE && read < write;
  const later = request.at !== null && (thread.last_at === null || request.at >= thread.last_at);
  return {
    requests: thread.requests + 1,
    input: thread.input + input,
    cache_read: thread.cache_read + read,
    cache_write: thread.cache_write + write,
    last_at: later ? request.at : thread.last_at,
    ttl_ms: ttl_ms ?? thread.ttl_ms,
    last_prompt: later || thread.last_at === null ? input + read + write : thread.last_prompt,
    recent: [...thread.recent, { prompt: input + read + write, read, write, miss }].slice(-CACHE_RECENT),
    last_id: request.id ?? thread.last_id,
  };
}

/** The lifetime a thread's cache has: what its latest write asked for, else the default for its kind. */
export function cacheTtlMs(thread: CacheThread, main: boolean): number {
  return thread.ttl_ms ?? (main ? CACHE_DEFAULT_TTL_MAIN_MS : CACHE_DEFAULT_TTL_SUBAGENT_MS);
}

/** Milliseconds the cache is estimated to live yet; 0 when cold; null before any request. */
export function cacheLeftMs(thread: CacheThread, main: boolean, now: number): number | null {
  if (thread.last_at === null) return null;
  return Math.max(0, thread.last_at + cacheTtlMs(thread, main) - now);
}

/** Share of the prompt tokens that came from the cache, 0..100 (rounded); null when nothing was prompted. */
export function cacheHitPercent(thread: CacheThread): number | null {
  const total = thread.input + thread.cache_read + thread.cache_write;
  return total === 0 ? null : Math.round(thread.cache_read / total * 100);
}

/** `green` above 15 minutes left, `yellow` from there down to the last second, `cold` at 0. */
export type CacheTone = "green" | "yellow" | "cold";
export function cacheTone(leftMs: number): CacheTone {
  if (leftMs <= 0) return "cold";
  return leftMs > CACHE_GREEN_ABOVE_MS ? "green" : "yellow";
}

/** Whole minutes left, rounded up, so a cache with seconds to live does not read as cold. */
export function cacheMinutes(leftMs: number): number {
  return Math.max(0, Math.ceil(leftMs / 60_000));
}

/** The latest requests' verdicts for the popover's "Last 5" line. */
export function cacheRecentOf(thread: CacheThread): CacheRecent[] {
  return thread.recent.slice(-CACHE_RECENT);
}
