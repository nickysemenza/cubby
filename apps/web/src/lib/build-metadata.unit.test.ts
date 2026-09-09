import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { buildMetadataQueryOptions } from "./build-metadata";

describe("build metadata snapshot", () => {
  it("retains the SSR snapshot through hydration and invalidation", async () => {
    const server = new QueryClient();
    const browser = new QueryClient();
    const snapshot = {
      date: "2026-01-02T00:30:00Z",
      branch: "document-source",
      commit: "abc1234",
    };
    try {
      server.setQueryData(buildMetadataQueryOptions.queryKey, snapshot);
      hydrate(browser, dehydrate(server));
      // oxlint-disable-next-line anti-slop/no-direct-query-invalidation -- Exercise snapshot retention even if the cache is explicitly invalidated.
      await browser.invalidateQueries({
        queryKey: buildMetadataQueryOptions.queryKey,
      });
      // A refetch would replace this document's version with the server's
      // current metadata (or require a network request in the browser).
      await expect(
        browser.ensureQueryData(buildMetadataQueryOptions),
      ).resolves.toEqual(snapshot);
    } finally {
      server.clear();
      browser.clear();
    }
  });
});
