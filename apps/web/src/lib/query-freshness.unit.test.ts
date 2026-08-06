import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { configureQueryFreshness } from "./query-freshness";
import { normalizeTRPCQueryKey, queryKeys } from "./query-keys";

describe("configureQueryFreshness", () => {
  it("keeps stable detail and indexes warm but preserves the mutable default", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } },
    });
    configureQueryFreshness(client);

    expect(
      client.getQueryDefaults(normalizeTRPCQueryKey(queryKeys.product.getByID)),
    ).toMatchObject({
      staleTime: 300_000,
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
    });
    expect(
      client.getQueryDefaults(
        normalizeTRPCQueryKey(queryKeys.product.getByShortcode),
      ),
    ).toMatchObject({ staleTime: 300_000 });
    expect(
      client.getQueryDefaults(
        normalizeTRPCQueryKey(queryKeys.location.makeTree),
      ),
    ).toMatchObject({ staleTime: 120_000 });
    expect(
      client.getQueryDefaults(normalizeTRPCQueryKey(queryKeys.task.list)),
    ).toEqual({});
  });
});
