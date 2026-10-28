import { statementSuggestionRow } from "@cubby/schemas/suggestion-list";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { mock } from "~/lib/test/mock-schema";

import { SuggestionEvidence } from "./suggestion-evidence";
import { SuggestionReviewProvider } from "./suggestion-review-context";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => harness?.dispose());

// Ready household-card spending must render without constructing a null member link.
it("renders an unknown purchaser from the nullable ready-plan wire shape", () => {
  harness = createBrowserTestHarness();
  const row = mock(statementSuggestionRow, {
    overrides: {
      fingerprint: "synthetic-fingerprint",
      automaticRule: "synthetic-booking@2026-10-24.2",
      record: { entity: "financialAccount", id: "FAC-2345" },
      evidence: {
        accountId: "FAC-2345",
        ownerId: null,
        recommended: "create",
        candidates: [],
        sourceCategories: [],
        spending: {
          status: "ready",
          effect: "create_aggregate",
          purchaserId: null,
          purchaserSnapshot: "synthetic-purchaser",
          vendorId: null,
          vendorName: "Synthetic Orchard",
          spendingCategoryId: "SPC-2345",
          purchaseId: null,
          snapshot: "synthetic-spending",
          candidates: [],
          request: { advice: null, rejectedPurchaseIds: [] },
        },
      },
    },
  });
  render(
    <SuggestionReviewProvider scope="synthetic">
      <SuggestionEvidence row={row} />
    </SuggestionReviewProvider>,
    { wrapper: harness.wrapper },
  );
  expect(
    screen.getByText("Household card does not identify an individual"),
  ).toBeVisible();
  expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
});
