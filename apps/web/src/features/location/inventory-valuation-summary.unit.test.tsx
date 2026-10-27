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
const envelope = (
  result: ValuationEnvelope["result"],
  work: ValuationEnvelope["work"] = { kind: "idle" },
): ValuationEnvelope => ({
  current: {
    assignment: null,
    controls: { kind: "readonly", reason: "computed" },
  },
  result,
  work,
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

    it("keeps an unpublished pending result distinct from zero and pricing counts", () => {
      show(envelope({ kind: "missing" }, { kind: "pending" }));
      expect(screen.getByText("Updating…")).toBeVisible();
      expect(screen.getByLabelText("Updating")).toBeVisible();
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
      expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
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

    it("keeps a stale usable value and exposes its raw refresh failure", () => {
      const error = "Synthetic SQLSTATE 40001: valuation refresh failed";
      show(
        envelope(
          {
            kind: "cached",
            computedAt: "2026-10-01T00:00:00Z",
            freshness: "stale",
            decision: {
              outcome: { kind: "value", value: totals(37) },
              provenance: { kind: "computed" },
            },
          },
          { kind: "failed", error, retryAt: null },
        ),
      );
      expect(screen.getByText("$37.00")).toBeVisible();
      expect(screen.getByText(/no pricing for 2/)).toBeVisible();
      expect(screen.getByLabelText("Updating")).toBeVisible();
      expect(screen.getByRole("button", { name: error })).toBeVisible();
    });

    it("shows an unavailable result with the raw failure and no money or pricing counts", () => {
      const error = "Synthetic valuation source unavailable";
      show(
        envelope({ kind: "missing" }, { kind: "failed", error, retryAt: null }),
      );
      expect(screen.getByText("Unavailable")).toBeVisible();
      expect(screen.getByRole("button", { name: error })).toBeVisible();
      expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/no pricing/)).not.toBeInTheDocument();
    });
  },
);
