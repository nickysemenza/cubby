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
import { DenseCellContext } from "~/ui/values/stacked-value";

import { compactFieldRendererFor } from "./compact-field-renderers";
import { DataQualityValue } from "./data-quality-value";

afterEach(cleanup);

describe("quality cell", () => {
  it("states a complete record without a number", () => {
    render(<DataQualityValue quality={{ status: "complete", missing: 0 }} />);
    expect(screen.getByText("Complete")).toBeVisible();
  });

  it.each([
    ["needs_data", "text-warning-ink"],
    ["defect", "text-destructive"],
  ] as const)(
    "counts what a %s record is missing in its tone",
    (status, tone) => {
      const { container } = render(
        <DataQualityValue quality={{ status, missing: 3 }} />,
      );
      const cell = container.querySelector("[data-quality-status]");
      expect(cell).toHaveTextContent("3 missing");
      expect(cell).toHaveClass(tone);
    },
  );

  it("keeps only the count in a dense cell", () => {
    render(
      <DenseCellContext.Provider value={{ linksTo: null }}>
        <DataQualityValue quality={{ status: "needs_data", missing: 2 }} />
      </DenseCellContext.Provider>,
    );
    expect(screen.queryByText(/missing/)).toBeNull();
  });
});

describe("compact quality reads", () => {
  it("renders the published envelope instead of a retired scalar", () => {
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
      expect(screen.getByText("Complete")).toBeVisible();
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
      expect(screen.getByText("Complete")).toBeVisible();
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
