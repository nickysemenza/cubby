import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { entityDetailRootKey } from "~/entities/entity-detail.functions";
import { configureQueryFreshness } from "./query-freshness";
import { normalizeQueryRoot, queryKeys } from "./query-keys";

describe("configureQueryFreshness", () => {
  it("keeps stable detail and indexes warm but preserves the mutable default", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } },
    });
    configureQueryFreshness(client);

    expect(
      client.getQueryDefaults(entityDetailRootKey("product")),
    ).toMatchObject({ staleTime: 300_000 });
    expect(
      client.getQueryDefaults(normalizeQueryRoot(queryKeys.location.makeTree)),
    ).toMatchObject({ staleTime: 120_000 });
    expect(
      client.getQueryDefaults(normalizeQueryRoot(queryKeys.task.list)),
    ).toEqual({});
  });
});
