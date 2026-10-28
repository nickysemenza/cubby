import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { render, screen, within } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { fieldExplanation } from "~/integrations/tanstack-query/generated/catalog/fieldExplanation.gen";
import { DecisionChain } from "~/ui/derived/decision-chain";
import {
  ReadableExplanationValue,
  WhyValueContents,
} from "~/ui/derived/why-value";
import { Popover, PopoverContent } from "~/ui/primitives/popover";

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
      rule: { id: "synthetic", revision: 1, description: "Synthetic rule" },
      evaluatedAt: "2026-10-01T00:00:00Z",
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
      comparison: {
        kind: "unavailable",
        reason: "Cached source evidence differs from current sources",
      },
      sources: [
        {
          label: "Synthetic current source",
          entity: source,
          value: "electrical",
        },
      ],
    });
    harness.queryClient.setQueryData(
      fieldExplanation.explain.queryKey({
        entityKind: "expense",
        entityId: "EXP-2345",
        field: "trade",
        surface: "detail",
      }),
      data,
    );
    render(
      <Popover open>
        <PopoverContent>
          <WhyValueContents
            entity="expense"
            id="EXP-2345"
            field="trade"
            label="Trade"
          />
        </PopoverContent>
      </Popover>,
      { wrapper: harness.wrapper },
    );
    expect(
      screen.getByRole("list", { name: "Evidence sources" }),
    ).toHaveTextContent("skipped");
    expect(
      screen.getByRole("list", { name: "Evidence sources" }),
    ).not.toHaveTextContent("deciding");
  },
);

it("renders resolved rollup values with one linked label per item", () => {
  render(
    <ReadableExplanationValue
      value={[
        {
          label: "Synthetic owner",
          ref: { entityKind: "ledgerParty", entityId: "LPY-4K7M" },
          inherited: false,
        },
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.getAllByText("Synthetic owner", { exact: true })).toHaveLength(
    1,
  );
  expect(screen.getByRole("link", { name: "Synthetic owner" })).toHaveAttribute(
    "href",
    "/ledger-parties/LPY-4K7M",
  );
  expect(screen.queryByText("Entity Kind")).not.toBeInTheDocument();
  expect(screen.queryByText("Inherited")).not.toBeInTheDocument();
});

it("uses the declared Household label for an explicit None result and assignment", () => {
  const data = fromPartial<FieldExplanationOutput>({
    subject: { entityKind: "inventory", entityId: "INV-4K7M" },
    field: "ownerLedgerPartyId",
    envelope: {
      current: {
        assignment: { kind: "none" },
        controls: {
          kind: "editable",
          canSetNone: false,
          canConfirm: false,
          reset: { kind: "unavailable" },
        },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "empty", reason: "explicit_none" },
          provenance: { kind: "own", ownership: { kind: "record" } },
        },
      },
      work: { kind: "idle" },
    },
  });
  render(<DecisionChain data={data} />, { wrapper: harness.wrapper });
  expect(
    within(screen.getByRole("region", { name: "Effective result" })).getByText(
      "Household",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Your choice" })).getByText(
      "Household",
      { exact: true },
    ),
  ).toBeVisible();
});
