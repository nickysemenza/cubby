import { afterEach, describe, expect, it, vi } from "vitest";
import { PartialUpcBatchLookupError, UPCLookupClient } from "./upc-lookup";

describe("UPCLookupClient lookupBatch health contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws on a provider failure instead of turning it into an empty successful batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("unavailable", { status: 503 })),
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const client = new UPCLookupClient("http://localhost:8787");
    await expect(client.lookupBatch(["012345678905"])).rejects.toThrow(
      "UPC batch lookup failed",
    );
  });

  it("still treats an empty successful provider batch as a checked negative result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ products: [], pending: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    const client = new UPCLookupClient("http://localhost:8787");
    await expect(client.lookupBatch(["012345678905"])).resolves.toEqual(
      new Map(),
    );
  });

  it("preserves completed chunks when a later chunk fails", async () => {
    const upcs = Array.from({ length: 201 }, (_, index) =>
      index.toString().padStart(12, "0"),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            products: [
              {
                upc: upcs[0],
                name: "Completed hit",
                manufacturer: null,
                brand: null,
                category: null,
                description: null,
                priceDollars: null,
                imageUrl: null,
                source: "upcitemdb",
              },
            ],
            pending: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new UPCLookupClient("http://localhost:8787", undefined, {
      fetcher,
    });

    const error = await client.lookupBatch(upcs).catch((caught) => caught);

    expect(error).toBeInstanceOf(PartialUpcBatchLookupError);
    expect(error.results.get(upcs[0]!)).toMatchObject({
      name: "Completed hit",
    });
    expect(error.failedUpcs).toEqual([upcs[200]]);
  });
});
