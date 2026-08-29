import { describe, expect, it } from "vitest";

import {
  canMarkAllSelectedNoUsda,
  shouldShowEnrichmentEmptyState,
} from "./enrichment-workbench";

const markableRow = {
  hasProduct: true,
  hasUsdaLink: false,
};

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

describe("canMarkAllSelectedNoUsda", () => {
  it("requires every selected ingredient to own an unlinked product", () => {
    expect(canMarkAllSelectedNoUsda([markableRow])).toBe(true);
    expect(
      canMarkAllSelectedNoUsda([
        markableRow,
        { hasProduct: false, hasUsdaLink: false },
      ]),
    ).toBe(false);
    expect(
      canMarkAllSelectedNoUsda([
        markableRow,
        { hasProduct: true, hasUsdaLink: true },
      ]),
    ).toBe(false);
  });

  it("does not offer the action for an empty selection", () => {
    expect(canMarkAllSelectedNoUsda([])).toBe(false);
  });
});
