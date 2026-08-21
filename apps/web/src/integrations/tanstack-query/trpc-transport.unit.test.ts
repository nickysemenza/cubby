import { createTRPCUntypedClient } from "@trpc/client";
import { describe, expect, it, vi } from "vitest";
import type { TRPCRouter } from "~/integrations/trpc/router";
import { createTRPCTransportLink } from "./trpc-transport";

const TEST_URL = "https://cubby.test/api/trpc";
const FETCH_STOP = new Error("stop after capturing request");

function createClientWithFetch(fetch: typeof globalThis.fetch) {
  return createTRPCUntypedClient<TRPCRouter>({
    links: [createTRPCTransportLink({ url: TEST_URL, fetch })],
  });
}

describe("createTRPCTransportLink", () => {
  it("sends an oversized batched query once with its input in a POST body", async () => {
    const productShortcodes = Array.from({ length: 497 }, () => "PRD-4D85");
    const input = { productShortcodes };
    const legacyGetUrl = `${TEST_URL}/problems.recipeUsageByProduct?batch=1&input=${encodeURIComponent(
      JSON.stringify({ 0: { json: input } }),
    )}`;
    expect(legacyGetUrl.length).toBeGreaterThan(8000);

    const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => {
      throw FETCH_STOP;
    });
    const client = createClientWithFetch(fetchSpy);

    await expect(
      client.query("problems.recipeUsageByProduct", input),
    ).rejects.toThrow(FETCH_STOP.message);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${TEST_URL}/problems.recipeUsageByProduct?batch=1`);
    expect(init?.method).toBe("POST");
    expect(url).not.toContain("input=");

    const body = JSON.parse(String(init?.body));
    expect(body["0"].json.productShortcodes).toEqual(productShortcodes);
  });

  it("keeps Problems hot-path queries unbatched while sending them as POST", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => {
      throw FETCH_STOP;
    });
    const client = createClientWithFetch(fetchSpy);

    await expect(client.query("problems.getFast")).rejects.toThrow(
      FETCH_STOP.message,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${TEST_URL}/problems.getFast`);
    expect(init?.method).toBe("POST");
  });

  it("keeps ordinary summaries and cached problem counts in one streamed batch", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => {
      throw FETCH_STOP;
    });
    const client = createClientWithFetch(fetchSpy);

    await Promise.allSettled([
      client.query("task.summary"),
      client.query("location.valuationSummary"),
      client.query("problems.getCounts"),
    ]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("task.summary");
    expect(url).toContain("location.valuationSummary");
    expect(url).toContain("problems.getCounts");
    expect(url).toContain("batch=1");
  });
});
