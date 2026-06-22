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
