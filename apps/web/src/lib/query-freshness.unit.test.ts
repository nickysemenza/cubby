import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { calendarRangeQueryOptions } from "~/app/calendar/calendar.functions";
import { entityDetailRootKey } from "~/entities/entity-detail.functions";
import { configureQueryFreshness } from "./query-freshness";
import {
  invalidateQueryRoots,
  invalidatesFor,
  normalizeQueryRoot,
  queryKeys,
} from "./query-keys";

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

describe("invalidateQueryRoots", () => {
  it("matches migrated Start queries through their nested entity root", () => {
    const client = new QueryClient();
    const key = calendarRangeQueryOptions({
      startDate: "2026-07-01",
      endDateExclusive: "2026-08-01",
    }).queryKey;
    client.setQueryData(key, { items: [], days: {} });

    invalidateQueryRoots(client, invalidatesFor("task"));

    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
});
