import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { screen, cleanup, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  createEditorBrowserTestHarness as createBrowserTestHarness,
  renderWithEditorMetadata as render,
} from "#web/tests/editor-metadata.fixtures.ts";

import { DecisionChain, DecisionValue } from "./decision-chain";

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

it("formats a structured Cost through its declared amount projection", () => {
  render(
    <DecisionValue
      entity="product"
      field="cost"
      value={{ kind: "item", amount: 40 }}
    />,
  );
  expect(screen.getByText("$40.00")).toBeVisible();
  expect(screen.queryByText("item")).not.toBeInTheDocument();
});

it("compares a cached value with an explicitly empty current result", () => {
  const data = explain(base);
  render(
    <DecisionChain
      data={{
        ...data,
        envelope: {
          ...data.envelope,
          result: {
            kind: "cached",
            computedAt: "2026-10-25T12:00:00Z",
            freshness: "stale",
            decision: {
              outcome: { kind: "value", value: 18 },
              provenance: { kind: "computed" },
            },
          },
        },
        comparison: {
          kind: "available",
          result: {
            kind: "live",
            decision: {
              outcome: { kind: "empty", reason: "unset" },
              provenance: { kind: "computed" },
            },
          },
        },
      }}
    />,
  );
  const comparison = screen.getByRole("region", {
    name: "Current input comparison",
  });
  expect(comparison).toHaveTextContent("Stored 18 → live Not set");
  expect(comparison).not.toHaveTextContent("null");
});

it.each([
  ["unset", "allocated", "Allocated"],
  ["mixed", "allocated", "Mixed"],
  ["unset", "computed", "Not set"],
] as const)("labels %s with %s provenance as %s", (reason, kind, label) => {
  const data = explain({
    ...base,
    current: {
      assignment: { kind: "inherit" },
      controls: { kind: "readonly", reason: "allocated" },
    },
    result: {
      kind: "live",
      decision: { outcome: { kind: "empty", reason }, provenance: { kind } },
    },
  });
  data.field = "projectId";
  render(<DecisionChain data={data} />);
  expect(
    within(screen.getByRole("region", { name: "Effective result" })).getByText(
      label,
    ),
  ).toBeVisible();
});
