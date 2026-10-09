import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { calendar } from "~/integrations/tanstack-query/generated/calendar.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

describe("operation-tag invalidation", () => {
  it("matches normalized operation queries through descriptor metadata", async () => {
    const client = new QueryClient();
    const options = calendar.range.queryOptions({
      startDate: "2026-07-01",
      endDateExclusive: "2026-08-01",
    });
    const query = client.getQueryCache().build(client, options);
    query.setData({ items: [], days: {} });

    await invalidateOperationTags(client, ripple.calendar);

    expect(query.state.isInvalidated).toBe(true);
  });
});
