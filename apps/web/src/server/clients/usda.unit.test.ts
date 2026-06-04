import { afterEach, describe, expect, it, vi } from "vitest";
import { USDAClient } from "./usda";

// Regression test for the prod 500 "operation was aborted due to timeout":
// usda-db is scale-to-zero (~50s cold start) and food enrichment is best-effort,
// so a thrown fetch error (AbortSignal timeout / network) must degrade to
// null/nulls — never propagate up and 500 the calling list query.

const makeTimeoutError = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });

describe("USDAClient resilience to fetch failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("findFoodsBatch resolves to nulls when fetch times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(makeTimeoutError())),
    );

    const client = new USDAClient("http://localhost:8080");
    const results = await client.findFoodsBatch([
      { kind: "upc", gtin_upc: "012345678905" },
      { kind: "ndb", ndb_number: 1234 },
    ]);

    expect(results).toEqual([null, null]);
  });

  it("findFood resolves to null when fetch times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(makeTimeoutError())),
    );

    const client = new USDAClient("http://localhost:8080");
    const result = await client.findFood({
      kind: "upc",
      gtin_upc: "012345678905",
    });

    expect(result).toBeNull();
  });

  it("findFood resolves to null on a generic network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network error"))),
    );

    const client = new USDAClient("http://localhost:8080");
    const result = await client.findFood({ kind: "ndb", ndb_number: 1234 });

    expect(result).toBeNull();
  });
});
