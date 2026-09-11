import type { MeasureEstimate } from "@cubby/schemas/nutrition";
import { describe, expect, it } from "vitest";

import { estimateStatusText, formatEstimate } from "~/lib/nutrition-format";

const complete = (
  lower: number,
  upper: number | null = null,
): Extract<MeasureEstimate, { status: "complete" }> => ({
  status: "complete",
  lower,
  upper,
  coverage: { covered: 1, total: 1 },
});

describe("formatEstimate", () => {
  it("keeps a partial known subtotal explicit, including ranges", () => {
    expect(
      formatEstimate(
        {
          ...complete(20, 25),
          status: "partial",
          coverage: { covered: 2, total: 3 },
        },
        String,
      ),
    ).toBe("20–25 known · partial");
  });

  it("does not turn absent or pending data into a zero", () => {
    const unavailable: MeasureEstimate = {
      status: "unavailable",
      reason: "no_data",
    };
    expect(formatEstimate(unavailable, String)).toBe("—");
    expect(estimateStatusText(unavailable)).toBe(
      "Unavailable: no nutrition data",
    );
    expect(
      formatEstimate({ status: "pending", reason: "totals_stale" }, String),
    ).toBe("Pending");
  });

  it("preserves an explicit zero as known nutrition", () => {
    expect(formatEstimate(complete(0), String)).toBe("0");
  });
});
