import { describe, expect, it } from "vitest";
import { dashboardCountsQueryOptions } from "~/lib/dashboard.functions";

describe("dashboard counts Start query options", () => {
  it("preserves the dashboard query key and operation metadata", () => {
    const options = dashboardCountsQueryOptions();

    expect(options.queryKey).toEqual([
      ["dashboard", "counts"],
      { type: "query" },
    ]);
    expect(options.meta).toMatchObject({
      transport: "start",
      operation: "dashboard.counts",
      observedByTransport: true,
    });
  });
});
