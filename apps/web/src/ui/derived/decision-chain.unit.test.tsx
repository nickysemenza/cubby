import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { DecisionChain } from "./decision-chain";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => {
  cleanup();
  harness?.dispose();
});
function explain(resolution: FieldResolution): FieldExplanationOutput {
  return {
    subject: { entityKind: "expense", entityId: "EXP-4K7M" },
    field: "trade",
    label: "Trade",
    value: resolution.value,
    evaluatedAt: "2026-10-25T12:00:00Z",
    rule: {
      id: "synthetic-resolution",
      revision: 1,
      description: "Synthetic resolution",
    },
    resolution,
    actions: [],
    sources: [],
    truncated: false,
  };
}
const base: FieldResolution = {
  mode: "explicit",
  storedValue: "other",
  value: "other",
  fallbackValue: null,
  source: "expense override",
  sourceEntity: null,
  matchesFallback: false,
  canReset: false,
};
it("uses the declared enum label for the deciding value", () => {
  render(<DecisionChain data={explain(base)} />);
  expect(screen.getByText("Other")).toBeVisible();
  expect(screen.queryByText("other")).not.toBeInTheDocument();
});
it("links the inherited source in the deciding level", () => {
  harness = createBrowserTestHarness();
  render(
    <DecisionChain
      data={explain({
        ...base,
        mode: "inherit",
        storedValue: null,
        sourceEntity: {
          entityKind: "purchase",
          entityId: "PUR-4K7M",
          name: "Synthetic purchase",
        },
      })}
    />,
    { wrapper: harness.wrapper },
  );
  expect(
    screen.getByRole("link", { name: "Synthetic purchase" }),
  ).toHaveAttribute("href", "/purchases/PUR-4K7M");
});
it("retains a system decision's provenance without inventing a purchase allocation", () => {
  render(
    <DecisionChain
      data={explain({
        ...base,
        mode: "allocated",
        source: "reviewed reimbursement",
      })}
    />,
  );
  expect(screen.getByText("Reviewed reimbursement")).toBeVisible();
  expect(
    screen.queryByText("Allocated across the purchase"),
  ).not.toBeInTheDocument();
});
