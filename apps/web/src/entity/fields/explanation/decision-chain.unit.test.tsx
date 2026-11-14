import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { screen, cleanup, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  createEditorBrowserTestHarness as createBrowserTestHarness,
  renderWithEditorMetadata as render,
} from "#web/tests/editor-metadata.fixtures.ts";

import { DecisionValue, FieldChain } from "./decision-chain";

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
};
function Chain({ data }: { data: FieldExplanationOutput }) {
  return (
    <FieldChain
      entity={data.subject.entityKind}
      id={data.subject.entityId}
      field={data.field}
      envelope={data.envelope}
      data={data}
    />
  );
}
const chain = () =>
  within(screen.getByRole("list", { name: "Value decision chain" }));

it("uses the declared enum label for the deciding value", () => {
  render(<Chain data={explain(base)} />);
  expect(chain().getByText("Other")).toBeVisible();
  expect(screen.queryByText("other")).not.toBeInTheDocument();
});
it("links the inherited source in the deciding level", () => {
  harness = createBrowserTestHarness();
  render(
    <Chain
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
    <Chain
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
    screen.queryByRole("button", { name: "Let Cubby decide" }),
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
  render(<Chain data={data} />);
  expect(chain().getByText(label)).toBeVisible();
});
