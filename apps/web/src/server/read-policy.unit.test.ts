import { describe, expect, it } from "vitest";

import { mutationChangesHouseholdData, readPolicyFor } from "./read-policy";

describe("shared read policy", () => {
  it("uses bounded-stale context for representative display reads", () => {
    for (const operation of [
      "ai.usageRecent",
      "meal.getShoppingList",
      "problems.getByType",
      "suggestions.getRecipeAvailability",
      "calendar.range",
      "collection.detail",
      "cookbook.detail",
      "expense.analytics",
      "image.projectSummaries",
      "ingredient.recipeUsages",
      "location.makeTree",
      "meal.getPreparations",
      "project.dashboardSummary",
      "recommendations.placement",
      "recipe.getDependencyGraph",
      "task.board",
    ] as const) {
      expect(readPolicyFor(operation, "query")).toBe("context");
    }
  });

  it("reads the bounded Home summaries without a freshness RPC", () => {
    for (const operation of [
      "expense.monthlySummary",
      "location.valuationSummary",
      "meal.getNutrition",
      "meal.upcomingSummary",
      "task.todayBriefing",
    ] as const) {
      expect(readPolicyFor(operation, "query")).toBe("strong");
    }
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
