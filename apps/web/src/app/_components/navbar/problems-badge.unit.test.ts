import { describe, expect, it } from "vitest";

import { problemsBadgeQueryOptions } from "./problems-badge";

describe("ProblemsBadge", () => {
  it("requests the count-only route with the five-minute cache", () => {
    const options = problemsBadgeQueryOptions(true);

    expect(options).toMatchObject({
      queryKey: ["operation", "problems.getCounts", { input: undefined }],
      staleTime: 5 * 60 * 1000,
      enabled: true,
    });
  });
});
