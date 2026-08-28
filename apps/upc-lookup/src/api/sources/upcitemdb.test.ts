import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupUPCitemdb } from "./upcitemdb";

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupUPCitemdb status mapping", () => {
  it("returns found with data on a populated 200", async () => {
    mockFetch(() =>
      jsonResponse({
        code: "OK",
        total: 1,
        offset: 0,
        items: [{ ean: "1", title: "Widget", brand: "Acme" }],
      }),
    );

    const result = await lookupUPCitemdb("012345678905");

    expect(result.status).toBe("found");
    if (result.status === "found") {
      // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
      expect(result.data.name).toBe("Widget");
      // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
      expect(result.data.brand).toBe("Acme");
    }
  });

  it("parses offers whose list_price is a number (real upstream shape)", async () => {
    // Regression: upcitemdb sends `list_price` as a number (e.g. 149). The
    // schema previously required a string, so every offer-bearing response
    // failed parse → transient `error` → the UPC was cached as neither a
    // product nor a miss. See types.ts upcitemdbOfferSchema.
    mockFetch(() =>
      jsonResponse({
        code: "OK",
        total: 1,
        offset: 0,
        items: [
          {
            ean: "0049206116313",
            title: "Jackson Steel Wheelbarrow",
            brand: "Jackson",
            offers: [
              {
                merchant: "Home Depot",
                title: "Steel Wheelbarrow",
                list_price: 149,
                price: 139,
              },
              {
                merchant: "Walmart",
                title: "Jackson Steel Wheelbarrow",
                list_price: 254.05,
                price: 199.99,
              },
            ],
          },
        ],
      }),
    );

    const result = await lookupUPCitemdb("049206116313");

    expect(result.status).toBe("found");
    if (result.status === "found") {
      // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
      expect(result.data.name).toBe("Jackson Steel Wheelbarrow");
      // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
      expect(result.data.priceDollars).toBeGreaterThan(0);
    }
  });

  it("returns error (not a miss) on a malformed 200 payload", async () => {
    // Item present but `title` is the wrong type — the schema rejects it, so we
    // must surface a transient error rather than caching the UPC as missing.
    mockFetch(() =>
      jsonResponse({ code: "OK", total: 1, offset: 0, items: [{ title: 42 }] }),
    );
    expect(await lookupUPCitemdb("012345678905")).toEqual({ status: "error" });
  });

  it("returns error (not a miss) on a 200 whose shape lacks items entirely", async () => {
    // A wholesale response-shape change (no `items` key) must fail parse and
    // surface as transient — not be cached as a not_found miss.
    mockFetch(() => jsonResponse({ code: "OK", total: 0, offset: 0 }));
    expect(await lookupUPCitemdb("012345678905")).toEqual({ status: "error" });
  });

  it("returns not_found on a 200 with no items", async () => {
    mockFetch(() =>
      jsonResponse({ code: "OK", total: 0, offset: 0, items: [] }),
    );
    expect(await lookupUPCitemdb("012345678905")).toEqual({
      status: "not_found",
    });
  });

  it("returns not_found on a 404", async () => {
    mockFetch(() => jsonResponse({}, 404));
    expect(await lookupUPCitemdb("012345678905")).toEqual({
      status: "not_found",
    });
  });

  it("returns error (not a miss) on a 429 rate limit", async () => {
    mockFetch(() => jsonResponse({}, 429));
    expect(await lookupUPCitemdb("012345678905")).toEqual({ status: "error" });
  });

  it("returns error on a 5xx", async () => {
    mockFetch(() => jsonResponse({}, 503));
    expect(await lookupUPCitemdb("012345678905")).toEqual({ status: "error" });
  });

  it("returns error on a network/timeout failure", async () => {
    mockFetch(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    expect(await lookupUPCitemdb("012345678905")).toEqual({ status: "error" });
  });
});
