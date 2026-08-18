import { afterEach, describe, expect, it, vi } from "vitest";
import { UPCLookupClient } from "./upc-lookup";

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
});
