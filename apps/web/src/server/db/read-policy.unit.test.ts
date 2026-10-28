import { describe, expect, it } from "vitest";

import { mutationChangesHouseholdData, readPolicyFor } from "./read-policy";

describe("shared read policy", () => {
  it("allows bounded-stale reads for ordinary display workflows", () => {
    for (const operation of [
      "ai.usageRecent",
      "meal.getShoppingList",
      "problems.getByType",
      "recipeAvailability.getRecipeAvailability",
      "calendar.range",
      "expense.analytics",
      "image.projectSummaries",
      "ingredient.recipeUsages",
      "location.makeTree",
      "meal.getPreparations",
      "project.dashboardSummary",
      "suggestions.list",
      "suggestions.automaticDecisions",
      "recipe.getDependencyGraph",
    ] as const) {
      expect(readPolicyFor(operation, "query")).toBe("context");
    }
  });

  it("allows bounded-stale Home summaries", () => {
    for (const operation of [
      "expense.monthlySummary",
      "location.valuationSummary",
      "meal.getNutrition",
      "meal.upcomingSummary",
      "entityReport.get",
    ] as const) {
      expect(readPolicyFor(operation, "query")).toBe("context");
    }
  });

  it("keeps money entry and reconciliation authoritative, including generic entity reads", () => {
    for (const operation of [
      "financialTransaction.previewBooking",
      "purchase.settlementCandidates",
      "purchase.checkSplit",
      "expense.chargeContext",
      "inventory.receivingContext",
    ])
      expect(readPolicyFor(operation, "query")).toBe("strong");
    for (const entity of [
      "expense",
      "purchase",
      "financialTransaction",
      "transactionImport",
    ])
      expect(readPolicyFor("entity.detail", "query", entity)).toBe("strong");
    expect(readPolicyFor("entity.detail", "query", "product")).toBe("context");
    expect(
      readPolicyFor("entityReport.get", "query", undefined, [
        "purchase.reconciliation",
      ]),
    ).toBe("strong");
    expect(
      readPolicyFor("entityReport.getMany", "query", undefined, [
        "product.pricing",
        "purchase.financial-settlement",
      ]),
    ).toBe("strong");
  });

  it("makes every mutation strong regardless of its operation family", () => {
    expect(readPolicyFor("entity.mutate", "mutation")).toBe("strong");
    expect(readPolicyFor("calendar.rotateFeed", "mutation")).toBe("strong");
  });

  it("does not mark the maintenance cooldown claim as a data mutation", () => {
    expect(mutationChangesHouseholdData("maintenance.requestCatchUp")).toBe(
      false,
    );
    expect(mutationChangesHouseholdData("entity.mutate")).toBe(true);
  });
});
