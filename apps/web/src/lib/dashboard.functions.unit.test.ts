import { describe, expect, it } from "vitest";
import { dashboard } from "~/lib/dashboard.functions";

describe("dashboard counts Start query options", () => {
  it("preserves the dashboard query key and operation metadata", () => {
    const options = dashboard.counts.queryOptions();

    expect(options.queryKey).toEqual([
      "operation",
      "dashboard.counts",
      { input: undefined },
    ]);
    expect(options.meta).toMatchObject({
      transport: "start",
      operation: "dashboard.counts",
      observedByTransport: true,
    });
  });
});
