import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { DecisionChain } from "~/ui/derived/decision-chain";
import { ReadableExplanationValue } from "~/ui/derived/why-value";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

it("keeps shortcode-shaped retailer identifiers literal while linking source records", () => {
  render(
    <ReadableExplanationValue
      value={[
        {
          source: { id: "VEN-4K7M", name: "Synthetic evidence supplier" },
          kind: "retailer_sku",
          externalId: "RUN-4K7M",
        },
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.getByText("RUN-4K7M")).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "RUN-4K7M" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Synthetic evidence supplier" }),
  ).toHaveAttribute("href", "/vendors/VEN-4K7M");
});

it.each(["fresh", "stale"] as const)(
  "does not mark current sources as deciding for a %s cached result",
  (freshness) => {
    const source = {
      entityKind: "purchase" as const,
      entityId: "PUR-2345",
      name: "Synthetic source",
    };
    const data = fromPartial<FieldExplanationOutput>({
      subject: { entityKind: "expense", entityId: "EXP-2345" },
      field: "trade",
      envelope: {
        current: {
          assignment: { kind: "inherit" },
          controls: { kind: "readonly", reason: "computed" },
        },
        result: {
          kind: "cached",
          computedAt: "2026-10-01T00:00:00Z",
          freshness,
          decision: {
            outcome: { kind: "value", value: "plumbing" },
            provenance: { kind: "inherited", source },
          },
        },
        work: { kind: "idle" },
      },
      sources: [
        {
          label: "Synthetic current source",
          entity: source,
          value: "electrical",
        },
      ],
    });
    render(<DecisionChain data={data} />, { wrapper: harness.wrapper });
    expect(
      screen.getByRole("list", { name: "Value sources" }),
    ).toHaveTextContent("skipped");
    expect(
      screen.getByRole("list", { name: "Value sources" }),
    ).not.toHaveTextContent("deciding");
  },
);
