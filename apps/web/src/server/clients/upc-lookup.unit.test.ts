import { describe, expect, it, vi } from "vitest";

import { PartialUpcBatchLookupError, UPCLookupClient } from "./upc-lookup";

describe("UPCLookupClient lookupBatch health contract", () => {
  it("throws on a provider failure instead of turning it into an empty successful batch", async () => {
    const client = new UPCLookupClient("http://localhost:8787", undefined, {
      fetcher: async () => new Response("unavailable", { status: 503 }),
    });
    await expect(client.lookupBatch(["012345678905"])).rejects.toThrow(
      "UPC batch lookup failed",
    );
  });

  it("still treats an empty successful provider batch as a checked negative result", async () => {
    const client = new UPCLookupClient("http://localhost:8787", undefined, {
      fetcher: async () =>
        new Response(JSON.stringify({ products: [], pending: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
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
