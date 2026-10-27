import { dataQuality } from "@cubby/schemas/data-quality";
import {
  computedFieldEnvelope,
  fieldDecisionOf,
} from "@cubby/schemas/field-envelope";
import { testCompleteDataQuality } from "@cubby/schemas/testing";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { DenseCellContext } from "~/ui/common/stacked-value";

import { compactFieldRendererFor } from "./compact-field-renderers";
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

describe("compact quality reads", () => {
  it("renders the published envelope score instead of a retired scalar", () => {
    const harness = createBrowserTestHarness();
    try {
      const renderer = compactFieldRendererFor("task", "dataQuality");
      if (!renderer) throw new Error("Expected quality renderer");
      render(
        renderer({
          id: "TSK-4K7M",
          dataQuality: { status: "defect", score: 0 },
          fields: {
            dataQuality: fieldValueFixture(
              computedFieldEnvelope(dataQuality),
              testCompleteDataQuality(),
            ),
          },
        }),
        { wrapper: harness.wrapper },
      );
      expect(screen.getByText("100/100")).toBeVisible();
      expect(
        screen.queryByLabelText("Quality unavailable"),
      ).not.toBeInTheDocument();
    } finally {
      harness.dispose();
    }
  });

  it("retains a stale score and exposes its raw refresh error", () => {
    const harness = createBrowserTestHarness();
    try {
      const renderer = compactFieldRendererFor("task", "dataQuality");
      if (!renderer) throw new Error("Expected quality renderer");
      const envelope = fieldValueFixture(
        computedFieldEnvelope(dataQuality),
        testCompleteDataQuality(),
      );
      const decision = fieldDecisionOf(envelope);
      if (!decision) throw new Error("Expected published score");
      render(
        renderer({
          id: "TSK-4K7M",
          fields: {
            dataQuality: {
              ...envelope,
              result: {
                kind: "cached",
                decision,
                computedAt: "2026-10-01T00:00:00Z",
                freshness: "stale",
              },
              work: {
                kind: "failed",
                error: "Synthetic quality refresh failed",
                retryAt: null,
              },
            },
          },
        }),
        { wrapper: harness.wrapper },
      );
      expect(screen.getByText("100/100")).toBeVisible();
      expect(
        screen.getByRole("button", {
          name: "Synthetic quality refresh failed",
        }),
      ).toBeVisible();
    } finally {
      harness.dispose();
    }
  });

  it("keeps a missing computation distinct from a zero score", () => {
    const harness = createBrowserTestHarness();
    try {
      const renderer = compactFieldRendererFor("task", "dataQuality");
      if (!renderer) throw new Error("Expected quality renderer");
      render(
        renderer({
          id: "TSK-4K7M",
          fields: {
            dataQuality: fieldValueFixture(
              computedFieldEnvelope(dataQuality),
              undefined,
            ),
          },
        }),
        { wrapper: harness.wrapper },
      );
      expect(screen.getByText("Updating…")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "How data quality is determined" }),
      ).toBeVisible();
      expect(screen.queryByText("0/100")).not.toBeInTheDocument();
    } finally {
      harness.dispose();
    }
  });
});
