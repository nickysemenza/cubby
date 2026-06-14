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
      expect(result.data.name).toBe("Widget");
      expect(result.data.brand).toBe("Acme");
    }
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
