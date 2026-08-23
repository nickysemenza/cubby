// @vitest-environment happy-dom

import type { ProductQuantitySummaryOut } from "@cubby/schemas/product";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuantityVarianceHint } from "./LocationReviewPane";

const summary = (
  onHandUnits: number | null,
  quantityVariance: number | null,
): ProductQuantitySummaryOut => ({
  quantityLedger: {
    acquiredUnits: 3,
    exitedUnits: 0,
    expectedQuantity: 3,
    unknownAcquisitionLines: 0,
    unknownExitLines: 0,
    locationCount: 0,
  },
  onHandUnits,
  quantityVariance,
});

describe("QuantityVarianceHint", () => {
  it("renders the ledger and shelf figures only for a comparable mismatch", () => {
    render(<QuantityVarianceHint summary={summary(2, -1)} />);

    expect(screen.getByText("Ledger 3 · shelves 2")).toBeDefined();
    expect(document.querySelector(".text-warning")).not.toBeNull();
  });

  it.each([
    ["a matching count", summary(3, 0)],
    ["mixed units", summary(null, null)],
    ["an unavailable summary", undefined],
  ])("renders nothing for %s", (_label, value) => {
    render(<QuantityVarianceHint summary={value} />);

    expect(screen.queryByText(/^Ledger /)).toBeNull();
  });
});
