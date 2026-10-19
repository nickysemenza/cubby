import type { ConnectionProposal } from "@cubby/schemas/entity-connections";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  ConnectionCell,
  ConnectionSuggestionsProvider,
} from "./connection-suggestions";

const RECORD = "PRD-4K7M";
const OTHER = "PRD-5M8N";
const titleField = entitySummary.product.titleField;

const pair = (
  assessmentId: string,
  family: "product_pair" | "field",
): ConnectionProposal => ({
  relation: "product-identity",
  source: { entityKind: "product", entityId: RECORD },
  target: { entityKind: "product", entityId: OTHER },
  label: "Review product identity",
  evidence: { reasons: ["Synthetic pair"], contradictions: [], unknowns: [] },
  fingerprint: "f".repeat(64),
  review: { assessmentId, suppression: null, family },
  integration: { kind: "product-pair-review" },
});

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: () => void;
let proposals: ConnectionProposal[] = [];

beforeEach(() => {
  harness = createBrowserTestHarness();
  restoreDispatch = overrideStartDispatch(async (operation, input) => {
    if (operation !== "connection.readBatch")
      throw new Error(`Unexpected ${operation}`);
    return {
      ok: true,
      data: (
        input as { sources: { entityKind: string; entityId: string }[] }
      ).sources.map((source) => ({
        source,
        proposals: source.entityId === RECORD ? proposals : [],
      })),
    };
  });
});

afterEach(() => {
  restoreDispatch();
  harness.dispose();
});

const renderTitle = () =>
  render(
    <ConnectionSuggestionsProvider
      entity="product"
      records={[{ id: RECORD, [titleField]: "Synthetic lamp" }]}
    >
      <ConnectionCell
        record={{ id: RECORD, [titleField]: "Synthetic lamp" }}
        field={titleField}
      >
        Synthetic lamp
      </ConnectionCell>
    </ConnectionSuggestionsProvider>,
    { wrapper: harness.wrapper },
  );

describe("entity list possible-match badge", () => {
  it("links pending pair proposals to the record's Relationships section", async () => {
    proposals = [
      pair("11111111-1111-4111-8111-111111111111", "product_pair"),
      pair("22222222-2222-4222-8222-222222222222", "product_pair"),
    ];
    renderTitle();
    const badge = await screen.findByRole("link", {
      name: "2 possible matches",
    });
    expect(badge.getAttribute("href")).toMatch(
      new RegExp(`${RECORD}#relationships$`),
    );
  });

  it("shows no badge for proposals outside entity-pair families", async () => {
    proposals = [pair("33333333-3333-4333-8333-333333333333", "field")];
    renderTitle();
    expect(
      await screen.findByRole("button", { name: "Review connections" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /possible match/ }),
    ).not.toBeInTheDocument();
  });
});
