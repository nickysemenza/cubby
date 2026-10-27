import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { render, screen, cleanup, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { DecisionChain } from "./decision-chain";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => {
  cleanup();
  harness?.dispose();
});
function explain(resolution: ReadableFieldEnvelope): FieldExplanationOutput {
  return {
    subject: { entityKind: "expense", entityId: "EXP-4K7M" },
    field: "trade",
    label: "Trade",
    evaluatedAt: "2026-10-25T12:00:00Z",
    rule: {
      id: "synthetic-resolution",
      revision: 1,
      description: "Synthetic resolution",
    },
    envelope: resolution,
    comparison: { kind: "unavailable", reason: "not_computable" },
    actions: [],
    sources:
      resolution.result.kind !== "missing" &&
      resolution.result.decision.provenance?.kind === "inherited"
        ? [
            {
              label:
                resolution.result.decision.provenance.source.name ?? "Source",
              entity: resolution.result.decision.provenance.source,
              value: null,
            },
          ]
        : [],
    truncated: false,
  };
}
const base: ReadableFieldEnvelope = {
  current: {
    assignment: {
      kind: "value",
      value: "other",
      ownership: { kind: "record" },
    },
    controls: {
      kind: "editable",
      canSetNone: true,
      canConfirm: false,
      reset: { kind: "unavailable" },
    },
  },
  result: {
    kind: "live",
    decision: {
      outcome: { kind: "value", value: "other" },
      provenance: { kind: "own", ownership: { kind: "record" } },
    },
  },
  work: { kind: "idle" },
};
it("uses the declared enum label for the deciding value", () => {
  render(<DecisionChain data={explain(base)} />);
  expect(
    within(screen.getByRole("region", { name: "Effective result" })).getByText(
      "Other",
    ),
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Your choice" })).getByText(
      "Other",
    ),
  ).toBeVisible();
  expect(screen.queryByText("other")).not.toBeInTheDocument();
});
it("links the inherited source in the deciding level", () => {
  harness = createBrowserTestHarness();
  render(
    <DecisionChain
      data={explain({
        ...base,
        current: { ...base.current, assignment: { kind: "inherit" } },
        result: {
          kind: "live",
          decision: {
            outcome: { kind: "value", value: "other" },
            provenance: {
              kind: "inherited",
              source: {
                entityKind: "purchase",
                entityId: "PUR-4K7M",
                name: "Synthetic purchase",
              },
            },
          },
        },
      })}
    />,
    { wrapper: harness.wrapper },
  );
  expect(
    screen.getByRole("link", { name: "Synthetic purchase" }),
  ).toHaveAttribute("href", "/purchases/PUR-4K7M");
});
it("does not invent edit controls for an allocated result", () => {
  render(
    <DecisionChain
      data={explain({
        ...base,
        current: {
          assignment: null,
          controls: { kind: "readonly", reason: "allocated" },
        },
        result: {
          kind: "live",
          decision: {
            outcome: { kind: "empty", reason: "mixed" },
            provenance: { kind: "allocated" },
          },
        },
      })}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Use inherited" }),
  ).not.toBeInTheDocument();
});
