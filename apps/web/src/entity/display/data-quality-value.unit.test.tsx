import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DenseCellContext } from "~/ui/common/stacked-value";

import { DataQualityValue, qualityMeterFill } from "./data-quality-value";

afterEach(cleanup);

describe("quality cell", () => {
  // Regression: complete scores disappeared instead of remaining visible.
  it.each([false, true])(
    "shows a complete score (dense: %s) and retains its spoken status",
    (dense) => {
      const { container } = render(
        <DenseCellContext.Provider value={dense ? { linksTo: null } : null}>
          <DataQualityValue quality={{ status: "complete", score: 100 }} />
        </DenseCellContext.Provider>,
      );
      expect(screen.getByText(dense ? "100" : "100/100")).toBeVisible();
      expect(container).toHaveTextContent("Complete");
      expect(screen.getByText(", Complete")).toHaveClass("sr-only");
      expect(container.querySelector("[data-quality-meter]")).toBeNull();
    },
  );

  it.each([
    ["needs_data", "bg-warning"],
    ["defect", "bg-destructive"],
  ] as const)("meters a %s gap in its condition tone", (status, tone) => {
    const { container } = render(
      <DataQualityValue quality={{ status, score: 72 }} />,
    );
    const meter = container.querySelector("[data-quality-meter]");
    expect(meter).toHaveTextContent("72");
    const bars = [...(meter?.querySelectorAll("i") ?? [])];
    expect(bars).toHaveLength(5);
    expect(bars.filter((bar) => bar.classList.contains(tone))).toHaveLength(
      qualityMeterFill(72),
    );
  });

  it("never fills the meter for a gap", () => {
    expect(qualityMeterFill(99)).toBe(4);
    expect(qualityMeterFill(3)).toBe(1);
  });
});
