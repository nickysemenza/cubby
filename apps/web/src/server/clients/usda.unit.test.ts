import { afterEach, describe, expect, it, vi } from "vitest";

import { USDAClient } from "./usda";

// USDA now runs on Cloudflare Workers (always available), so a fetch/timeout/5xx
// is a real error and must THROW — never silently degrade to null/nulls, which
// would masquerade as "no data" and (e.g.) leave a recipe perpetually stale. A
// genuine 404 still resolves to null: the food simply isn't there.

const makeTimeoutError = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });

const jsonResponse = (status: number) =>
  new Response("null", {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("USDAClient surfaces fetch failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("findFoodsBatch throws when fetch times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(makeTimeoutError())),
    );
    const client = new USDAClient("http://localhost:8787");
    await expect(
      client.findFoodsBatch([{ kind: "upc", gtin_upc: "012345678905" }]),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("findFood throws when fetch times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(makeTimeoutError())),
    );
    const client = new USDAClient("http://localhost:8787");
    await expect(
      client.findFood({ kind: "upc", gtin_upc: "012345678905" }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("findFood throws on a generic network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network error"))),
    );
    const client = new USDAClient("http://localhost:8787");
    await expect(
      client.findFood({ kind: "ndb", ndb_number: 1234 }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("findFood throws on a 5xx service error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(503))),
    );
    const client = new USDAClient("http://localhost:8787");
    await expect(
      client.findFood({ kind: "ndb", ndb_number: 1234 }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("findFood resolves to null on a 404 (food not found)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(404))),
    );
    const client = new USDAClient("http://localhost:8787");
    const result = await client.findFood({ kind: "ndb", ndb_number: 1234 });
    expect(result).toBeNull();
  });
});

describe("USDAClient getFood cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("awaits and handles a cache write failure without failing the USDA response", async () => {
    const cachePut = vi.fn().mockRejectedValue(new Error("cache unavailable"));
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn().mockResolvedValue(undefined),
        put: cachePut,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ brandedFoodInfo: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const client = new USDAClient("http://localhost:8787");
    await expect(client.getBrandedFoodByID(123)).resolves.toBeNull();

    expect(cachePut).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Cache write failed"),
      expect.any(Error),
    );
  });
});

describe("USDAClient.findFoodsBatch request-scoped memo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // A FoodSummary-shaped body keyed so we can assert the right record comes back.
  const batchBody = (results: unknown[]) =>
    new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("reuses earlier results and only POSTs the lookups it hasn't seen", async () => {
    const fetchMock = vi.fn();
    // First call: one upc → one result. Second call mixes the same upc (memoed)
    // with a new fdc — only the fdc should be sent on the wire.
    fetchMock
      .mockResolvedValueOnce(batchBody([{ fdc_id: 1 }]))
      .mockResolvedValueOnce(batchBody([{ fdc_id: 2 }]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new USDAClient("http://localhost:8787");
    const first = await client.findFoodsBatch([
      { kind: "upc", gtin_upc: "012345678905" },
    ]);
    expect(first).toEqual([{ fdc_id: 1 }]);

    const second = await client.findFoodsBatch([
      { kind: "upc", gtin_upc: "012345678905" }, // memoed — not re-sent
      { kind: "fdc", fdc_id: 2 },
    ]);
    // Memoed record returned in order alongside the freshly-fetched one.
    expect(second).toEqual([{ fdc_id: 1 }, { fdc_id: 2 }]);

    // Two POSTs total; the second carried only the unseen fdc lookup.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as { body: string }).body,
    );
    expect(secondBody.lookups).toEqual([{ kind: "fdc", fdc_id: 2 }]);
  });

  it("does not re-POST a known miss within the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(batchBody([null]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new USDAClient("http://localhost:8787");
    const lookup = { kind: "ndb", ndb_number: 999 } as const;
    expect(await client.findFoodsBatch([lookup])).toEqual([null]);
    expect(await client.findFoodsBatch([lookup])).toEqual([null]);
    // The null is memoed as a known miss, so the second call sends nothing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent calls for the same lookup onto one POST", async () => {
    // The Problems-page pattern: two detectors enrich an overlapping product set
    // concurrently (under one Promise.all). The memo stores the in-flight
    // *promise*, so the second caller awaits the first's POST instead of issuing
    // its own — regression guard for the duplicate findByLookupBatch in the trace.
    const fetchMock = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(batchBody([{ fdc_id: 7 }])), 10),
          ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new USDAClient("http://localhost:8787");
    const lookup = { kind: "upc", gtin_upc: "012345678905" } as const;

    const [a, b] = await Promise.all([
      client.findFoodsBatch([lookup]),
      client.findFoodsBatch([lookup]),
    ]);

    expect(a).toEqual([{ fdc_id: 7 }]);
    expect(b).toEqual([{ fdc_id: 7 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
