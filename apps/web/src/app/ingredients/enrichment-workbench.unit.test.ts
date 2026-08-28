import { describe, expect, it } from "vitest";

import { shouldShowEnrichmentEmptyState } from "./enrichment-workbench";

describe("shouldShowEnrichmentEmptyState", () => {
  it("does not show success-empty copy when the query failed without cached rows", () => {
    expect(
      shouldShowEnrichmentEmptyState({
        isLoading: false,
        hasError: true,
        rowCount: 0,
      }),
    ).toBe(false);
  });

  it("shows the empty state only after a successful settled query", () => {
    expect(
      shouldShowEnrichmentEmptyState({
        isLoading: false,
        hasError: false,
        rowCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldShowEnrichmentEmptyState({
        isLoading: true,
        hasError: false,
        rowCount: 0,
      }),
    ).toBe(false);
  });
});
