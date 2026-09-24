import type { FoodLookupParam } from "@cubby/usda-schemas";
import { describe, expect, it, vi } from "vitest";
import { type JSONType, z } from "zod";

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
  it("findFoodsBatch throws when fetch times out", async () => {
    const client = new USDAClient("http://localhost:8787", async () =>
      Promise.reject(makeTimeoutError()),
    );
    await expect(
      client.findFoodsBatch([{ kind: "upc", gtin_upc: "012345678905" }]),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("findFood throws when fetch times out", async () => {
    const client = new USDAClient("http://localhost:8787", async () =>
      Promise.reject(makeTimeoutError()),
    );
    await expect(
      client.findFood({ kind: "upc", gtin_upc: "012345678905" }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("findFood throws on a generic network error", async () => {
    const client = new USDAClient("http://localhost:8787", async () =>
      Promise.reject(new TypeError("network error")),
    );
    await expect(
      client.findFood({ kind: "ndb", ndb_number: 1234 }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("findFood throws on a 5xx service error", async () => {
    const client = new USDAClient("http://localhost:8787", async () =>
      jsonResponse(503),
    );
    await expect(
      client.findFood({ kind: "ndb", ndb_number: 1234 }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("findFood resolves to null on a 404 (food not found)", async () => {
    const client = new USDAClient("http://localhost:8787", async () =>
      jsonResponse(404),
    );
    const result = await client.findFood({ kind: "ndb", ndb_number: 1234 });
    expect(result).toBeNull();
  });
});

describe("USDAClient getFood cache", () => {
  it("awaits and handles a cache write failure without failing the USDA response", async () => {
    const cachePut = vi.fn().mockRejectedValue(new Error("cache unavailable"));
    const client = new USDAClient(
      "http://localhost:8787",
      async () =>
        new Response(JSON.stringify({ brandedFoodInfo: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      {
        cache: {
          match: async () => undefined,
          put: cachePut,
        },
      },
    );
    await expect(client.getBrandedFoodByID(123)).resolves.toBeNull();

    expect(cachePut).toHaveBeenCalledOnce();
  });
});

describe("USDAClient counts cache", () => {
  it("reuses successful counts across requests for 24 hours", async () => {
    const counts = {
      usda_food: 42,
      usda_branded_food: 20,
      usda_nutrient: 10,
      usda_food_nutrient: 50,
      usda_measure_unit: 3,
      usda_food_portion: 4,
      usda_sr_legacy_food: 22,
    };
    const responses = new Map<string, Response>();
    const cache = {
      match: async (key: RequestInfo | URL) =>
        responses.get(String(key))?.clone(),
      put: async (key: RequestInfo | URL, response: Response) => {
        responses.set(String(key), response.clone());
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(counts), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(
      await new USDAClient("http://localhost:8787", fetcher, {
        cache,
      }).getCounts(),
    ).toEqual(counts);
    expect(
      await new USDAClient("http://localhost:8787", fetcher, {
        cache,
      }).getCounts(),
    ).toEqual(counts);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      responses
        .get("http://localhost:8787/counts")
        ?.headers.get("Cache-Control"),
    ).toBe("public, max-age=86400");
  });
});

describe("USDAClient.findFoodsBatch request-scoped memo", () => {
  // A FoodSummary-shaped body keyed so we can assert the right record comes back.
  const batchBody = (results: JSONType[]) =>
    new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("reuses earlier results and only POSTs the lookups it hasn't seen", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    // First call: one upc → one result. Second call mixes the same upc (memoed)
    // with a new fdc — only the fdc should be sent on the wire.
    fetchMock
      .mockResolvedValueOnce(batchBody([{ fdc_id: 1 }]))
      .mockResolvedValueOnce(batchBody([{ fdc_id: 2 }]));
    const client = new USDAClient("http://localhost:8787", fetchMock);
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
    const secondCall = fetchMock.mock.calls[1];
    if (!secondCall) throw new Error("Expected the second USDA batch request.");
    const secondBody = z
      .object({ lookups: z.array(z.json()) })
      .parse(JSON.parse(z.string().parse(secondCall[1]?.body)));
    expect(secondBody.lookups).toEqual([{ kind: "fdc", fdc_id: 2 }]);
  });

  it("does not re-POST a known miss within the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(batchBody([null]));
    const client = new USDAClient("http://localhost:8787", fetchMock);
    const lookup = {
      kind: "ndb",
      ndb_number: 999,
    } satisfies FoodLookupParam;
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
    const client = new USDAClient("http://localhost:8787", fetchMock);
    const lookup = {
      kind: "upc",
      gtin_upc: "012345678905",
    } satisfies FoodLookupParam;

    const [a, b] = await Promise.all([
      client.findFoodsBatch([lookup]),
      client.findFoodsBatch([lookup]),
    ]);

    expect(a).toEqual([{ fdc_id: 7 }]);
    expect(b).toEqual([{ fdc_id: 7 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
