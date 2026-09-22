import { entityRecommendationsOut } from "@cubby/schemas/entity-recommendations";
import { expenseOut } from "@cubby/schemas/project";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recommendations } from "~/lib/recommendations.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProjectSuggestionChips } from "./project-suggestion-chips";

const PROJECT_ID = testShortcode("project", "PRJ-2ABC");
const EXPENSE_ID = testShortcode("expense", "EXP-PLAN");
const expense = expenseOut.parse({
  id: EXPENSE_ID,
  name: "Planned expense",
  cost: 0,
  projectId: null,
  date: "2026-08-12",
  lineKind: "principal",
  lineBasis: "item_line",
  costType: "materials",
  trade: "electrical",
  future: false,
  vendor: null,
  vendorId: null,
  vendorLogo: null,
  productId: null,
  productName: null,
  productQuantity: null,
  purchaseId: null,
  purchaseDate: null,
  purchaseDisplayLabel: null,
  orderId: null,
  orderUrl: null,
  notes: null,
  url: null,
  projectName: null,
  beneficiaries: [],
  funders: [],
  sourceClaims: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  dataQuality: testCompleteDataQuality(),
});

const recommendationData = (basisKey: string, assigned = false) =>
  entityRecommendationsOut.parse({
    source: { entityType: "expense", entityId: EXPENSE_ID },
    basisKey,
    groups: [
      {
        kind: "expense-project",
        status: "ready",
        currentTarget: assigned
          ? { id: testShortcode("project", "PRJ-OLD1"), name: "Old project" }
          : null,
        proposals: [
          {
            kind: "expense-project",
            expenseId: EXPENSE_ID,
            target: { id: PROJECT_ID, name: "Workshop refresh" },
            effectiveStart: "2026-08-01",
            effectiveEnd: "2026-08-31",
            sameTradeCount: 2,
            exactProductCount: 0,
            supportingExpenses: [],
            reasons: ["2 electrical expenses already use this project."],
          },
        ],
      },
    ],
  });

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => harness.dispose());

function renderSuggestions(
  onAssign = vi.fn().mockResolvedValue(undefined),
  assigned = false,
) {
  const operations = {
    forEntity: recommendations.forEntity.withTransport(async () =>
      recommendationData("basis-1", assigned),
    ),
  };
  render(
    <ProjectSuggestionChips
      expense={expense}
      isPending={false}
      onAssign={onAssign}
      operations={operations}
    />,
    { wrapper: harness.wrapper },
  );
  return { onAssign, operations };
}

describe("ProjectSuggestionChips", () => {
  it("reviews an assigned or unassigned alternative without writing on selection", async () => {
    const { onAssign } = renderSuggestions(undefined, true);

    fireEvent.click(
      await screen.findByRole("button", { name: "Workshop refresh" }),
    );

    expect(onAssign).not.toHaveBeenCalled();
    expect(screen.getByText("Old project")).toBeVisible();
    expect(
      screen.getByText("Workshop refresh", { selector: "span" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(
      screen.getByText("2 electrical expenses already use this project."),
    ).toBeVisible();
  });

  it("writes only after Apply change and closes after success", async () => {
    const { onAssign } = renderSuggestions();
    fireEvent.click(
      await screen.findByRole("button", { name: "Workshop refresh" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));

    await waitFor(() => expect(onAssign).toHaveBeenCalledWith(PROJECT_ID));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Apply change" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("retains the review after a failed update so it can be retried", async () => {
    const onAssign = vi.fn().mockRejectedValue(new Error("offline"));
    renderSuggestions(onAssign);
    fireEvent.click(
      await screen.findByRole("button", { name: "Workshop refresh" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));

    await waitFor(() => expect(onAssign).toHaveBeenCalledOnce());
    expect(screen.getByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("button", { name: "Apply change" })).toBeVisible();
  });

  it("clears a selected review when the recommendation basis changes", async () => {
    const { operations } = renderSuggestions();
    fireEvent.click(
      await screen.findByRole("button", { name: "Workshop refresh" }),
    );
    expect(screen.getByRole("button", { name: "Apply change" })).toBeVisible();

    const options = operations.forEntity.queryOptions({
      entityType: "expense",
      entityId: EXPENSE_ID,
    });
    harness.queryClient.setQueryData(
      options.queryKey,
      recommendationData("basis-2"),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Apply change" }),
      ).not.toBeInTheDocument(),
    );
  });
});
