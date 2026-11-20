import { describe, expect, it } from "bun:test";
import {
  addCacheRequest, cacheHitPercent, cacheLeftMs, cacheMinutes, cacheTone, cacheTtlMs, cacheUsageOf, emptyCacheThread,
  CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, type CacheThread, type CacheUsage,
} from "./claude-cache.ts";

const usage = (input: number, read: number, write: number, ttl_ms: number | null = null): CacheUsage => ({ input, read, write, ttl_ms });
const fold = (requests: { id?: string; at: number; usage: CacheUsage }[]): CacheThread =>
  requests.reduce<CacheThread | undefined>((thread, request) => addCacheRequest(thread, { id: request.id ?? null, at: request.at, usage: request.usage }), undefined)!;

describe("cacheUsageOf", () => {
  it("reads the counts and picks the hour when the write was ephemeral_1h", () => {
    expect(cacheUsageOf({ input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 2144, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2144 } }))
      .toEqual({ input: 3, read: 100, write: 2144, ttl_ms: CACHE_TTL_1H_MS });
  });

  it("picks five minutes when the write was ephemeral_5m only", () => {
    expect(cacheUsageOf({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } })?.ttl_ms)
      .toBe(CACHE_TTL_5M_MS);
  });

  it("prefers the hour when a request wrote both", () => {
    expect(cacheUsageOf({ input_tokens: 1, cache_creation_input_tokens: 600, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 500 } })?.ttl_ms)
      .toBe(CACHE_TTL_1H_MS);
  });

  it("states no lifetime for a request that wrote nothing, or wrote with no breakdown", () => {
    expect(cacheUsageOf({ input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })?.ttl_ms).toBeNull();
    expect(cacheUsageOf({ input_tokens: 5, cache_creation_input_tokens: 900 })?.ttl_ms).toBeNull();
  });

  it("is null for a usage that holds no tokens", () => {
    expect(cacheUsageOf({ input_tokens: 0, output_tokens: 4 })).toBeNull();
    expect(cacheUsageOf(undefined)).toBeNull();
    expect(cacheUsageOf("x")).toBeNull();
  });
});

describe("addCacheRequest", () => {
  it("sums the counts and keeps the latest request's time and prompt", () => {
    const thread = fold([{ at: 1_000, usage: usage(10, 0, 500, CACHE_TTL_1H_MS) }, { at: 2_000, usage: usage(20, 500, 40) }]);
    expect(thread).toMatchObject({ requests: 2, input: 30, cache_read: 500, cache_write: 540, last_at: 2_000, last_prompt: 560 });
  });

  it("keeps the lifetime of the latest request that wrote, through requests that only read", () => {
    const thread = fold([
      { at: 1, usage: usage(1, 0, 100, CACHE_TTL_5M_MS) },
      { at: 2, usage: usage(1, 100, 0) },
    ]);
    expect(thread.ttl_ms).toBe(CACHE_TTL_5M_MS);
    expect(addCacheRequest(thread, { id: null, at: 3, usage: usage(1, 100, 50, CACHE_TTL_1H_MS) }).ttl_ms).toBe(CACHE_TTL_1H_MS);
  });

  it("counts one answer written as several blocks once", () => {
    const thread = fold([
      { id: "msg_1", at: 1, usage: usage(5, 100, 20) },
      { id: "msg_1", at: 2, usage: usage(5, 100, 20) },
      { id: "msg_2", at: 3, usage: usage(5, 120, 0) },
    ]);
    expect(thread.requests).toBe(2);
    expect(thread.cache_read).toBe(220);
  });

  it("does not move the clock back for an earlier request", () => {
    const thread = fold([{ at: 5_000, usage: usage(1, 1, 1) }, { at: 1_000, usage: usage(9, 9, 9) }]);
    expect(thread.last_at).toBe(5_000);
    expect(thread.last_prompt).toBe(3);
    expect(thread.requests).toBe(2);
  });

  describe("miss rule", () => {
    it("is not a miss on the first request, however much it writes", () => {
      expect(fold([{ at: 1, usage: usage(5, 0, 48_000) }]).recent).toEqual([{ prompt: 48_005, read: 0, write: 48_000, miss: false }]);
    });

    it("is a miss after the first when it writes 10k or more and reads back less than it wrote", () => {
      const thread = fold([{ at: 1, usage: usage(5, 0, 300) }, { at: 2, usage: usage(5, 2_000, 48_000) }]);
      expect(thread.recent[1]).toEqual({ prompt: 50_005, read: 2_000, write: 48_000, miss: true });
    });

    it("is no miss under 10k written, or when the read covers the write", () => {
      const thread = fold([
        { at: 1, usage: usage(5, 0, 300) },
        { at: 2, usage: usage(5, 0, 9_999) },
        { at: 3, usage: usage(5, 60_000, 50_000) },
        { at: 4, usage: usage(5, 50_000, 50_000) },
        { at: 5, usage: usage(5, 49_999, 50_000) },
      ]);
      expect(thread.recent.map((request) => request.miss)).toEqual([false, false, false, false, true]);
    });

    it("keeps the latest five requests", () => {
      const thread = fold(Array.from({ length: 8 }, (_, i) => ({ at: i, usage: usage(i + 1, 0, 0) })));
      expect(thread.recent.map((request) => request.prompt)).toEqual([4, 5, 6, 7, 8]);
    });
  });
});

describe("cacheTtlMs and cacheLeftMs", () => {
  it("defaults to an hour for the main session and five minutes for a subagent before any write", () => {
    const thread = fold([{ at: 0, usage: usage(5, 100, 0) }]);
    expect(cacheTtlMs(thread, true)).toBe(CACHE_TTL_1H_MS);
    expect(cacheTtlMs(thread, false)).toBe(CACHE_TTL_5M_MS);
  });

  it("counts down from the latest request and floors at cold", () => {
    const thread = fold([{ at: 1_000_000, usage: usage(1, 0, 10, CACHE_TTL_1H_MS) }]);
    expect(cacheLeftMs(thread, true, 1_000_000 + 18 * 60_000)).toBe(42 * 60_000);
    expect(cacheLeftMs(thread, true, 1_000_000 + CACHE_TTL_1H_MS)).toBe(0);
    expect(cacheLeftMs(thread, true, 1_000_000 + CACHE_TTL_1H_MS + 5)).toBe(0);
  });

  it("restarts from every request, read or write", () => {
    const thread = fold([{ at: 0, usage: usage(1, 0, 10, CACHE_TTL_5M_MS) }, { at: 4 * 60_000, usage: usage(1, 10, 0) }]);
    expect(cacheLeftMs(thread, false, 6 * 60_000)).toBe(3 * 60_000);
  });

  it("is null before any request", () => {
    expect(cacheLeftMs(emptyCacheThread(), true, 5)).toBeNull();
  });
});

describe("cache read-outs", () => {
  it("rates the hit as cacheRead over input + cacheRead + cacheWrite", () => {
    const thread = fold([{ at: 1, usage: usage(10, 900, 90) }, { at: 2, usage: usage(10, 990, 0) }]);
    // 1890 / 2000
    expect(cacheHitPercent(thread)).toBe(Math.round(1890 / 2000 * 100));
    expect(cacheHitPercent(emptyCacheThread())).toBeNull();
  });

  it("tones the chip green over 15 minutes, yellow below it, cold at 0", () => {
    expect(cacheTone(42 * 60_000)).toBe("green");
    expect(cacheTone(15 * 60_000)).toBe("yellow");
    expect(cacheTone(5 * 60_000)).toBe("yellow");
    expect(cacheTone(1)).toBe("yellow");
    expect(cacheTone(0)).toBe("cold");
  });

  it("rounds minutes up, so seconds of life do not read as cold", () => {
    expect(cacheMinutes(42 * 60_000)).toBe(42);
    expect(cacheMinutes(30_000)).toBe(1);
    expect(cacheMinutes(0)).toBe(0);
  });
});
