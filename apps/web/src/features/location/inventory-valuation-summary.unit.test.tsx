import { locationValuation } from "@cubby/schemas/location";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { InventoryValuationSummary } from "./inventory-valuation-summary";

type ValuationEnvelope = ComponentProps<
  typeof InventoryValuationSummary
>["valuation"];
const totals = (amount: number) =>
  locationValuation.parse({
    directValuation: amount,
    totalValuation: amount,
    directItemCount: 3,
    totalItemCount: 3,
    direct: { priced: 1, missingPricing: 2, miscNoPrice: 0 },
    total: { priced: 1, missingPricing: 2, miscNoPrice: 0 },
  });
const envelope = (result: ValuationEnvelope["result"]): ValuationEnvelope => ({
  current: {
    assignment: null,
    controls: { kind: "readonly", reason: "computed" },
  },
  result,
});

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  cleanup();
  harness.dispose();
});

describe.each(["compact", "full"] as const)(
  "%s Location valuation summary",
  (variant) => {
    const show = (valuation: ValuationEnvelope) =>
      render(
        <InventoryValuationSummary valuation={valuation} variant={variant} />,
        { wrapper: harness.wrapper },
      );

    it("keeps an unpublished result distinct from zero and pricing counts", () => {
      show(envelope({ kind: "missing" }));
      expect(screen.getByLabelText("Not calculated yet")).toBeVisible();
      expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/no pricing/)).not.toBeInTheDocument();
    });

    it("shows a successful empty outcome as a dash without invented totals", () => {
      show(
        envelope({
          kind: "live",
          decision: {
            outcome: { kind: "empty", reason: "unset" },
            provenance: { kind: "computed" },
          },
        }),
      );
      expect(screen.getByText("—")).toBeVisible();
      expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/no pricing/)).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("Not calculated yet"),
      ).not.toBeInTheDocument();
    });

    it("renders a successful numeric zero and its supplied pricing counts", () => {
      show(
        envelope({
          kind: "live",
          decision: {
            outcome: { kind: "value", value: totals(0) },
            provenance: { kind: "computed" },
          },
        }),
      );
      expect(screen.getByText("$0.00")).toBeVisible();
      expect(screen.getByText(/no pricing for 2/)).toBeVisible();
    });
  },
);
