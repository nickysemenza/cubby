import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calendar } from "~/app/calendar/calendar.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";

import {
  DEFERRED_INVALIDATION_DELAYS_MS,
  scheduleDeferredInvalidation,
} from "./deferred-invalidation";

/** A real, cache-tagged query the invalidation predicate actually matches —
 * mirrors the setup `query-freshness.unit.test.ts` uses for the same reason:
 * `invalidateOperationTags` is exercised for real, not mocked away. */
function buildTaggedQuery(client: QueryClient) {
  const options = calendar.range.queryOptions({
    startDate: "2026-07-01",
    endDateExclusive: "2026-08-01",
  });
  const query = client.getQueryCache().build(client, options);
  query.setData({ items: [], days: {} });
  return query;
}

describe("scheduleDeferredInvalidation", () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    client.clear();
  });

  it("fires at each configured delay", async () => {
    const query = buildTaggedQuery(client);

    scheduleDeferredInvalidation(client, ripple.calendar);
    expect(query.state.isInvalidated).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFERRED_INVALIDATION_DELAYS_MS[0]!);
    expect(query.state.isInvalidated).toBe(true);

    // Reset (as a real refetch would) to prove the SECOND timer independently
    // re-invalidates, not just that the first one's effect lingered.
    query.setData({ items: [], days: {} });
    expect(query.state.isInvalidated).toBe(false);

    await vi.advanceTimersByTimeAsync(
      DEFERRED_INVALIDATION_DELAYS_MS[1]! - DEFERRED_INVALIDATION_DELAYS_MS[0]!,
    );
    expect(query.state.isInvalidated).toBe(true);
  });

  it("cancel stops any still-pending timers", async () => {
    const query = buildTaggedQuery(client);

    const cancel = scheduleDeferredInvalidation(
      client,
      ripple.calendar,
      [1_000, 2_000],
    );
    cancel();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(query.state.isInvalidated).toBe(false);
  });
});
