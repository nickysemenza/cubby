import { describe, expect, it } from "vitest";

import { registeredStartOperationKind } from "~/lib/start-operation-observability";
import { Database } from "~/server/db";

import {
  applyReadPolicy,
  mutationChangesHouseholdData,
  readPolicyFor,
  STRONG_QUERY_OPERATIONS,
} from "./read-policy";

const database = (label: string) =>
  new Database(() => {
    throw new Error(`${label} must not resolve during policy tests`);
  });

describe("shared read policy", () => {
  it("keeps every registry member query-shaped and strong", () => {
    expect(new Set(STRONG_QUERY_OPERATIONS).size).toBe(
      STRONG_QUERY_OPERATIONS.length,
    );

    for (const operation of STRONG_QUERY_OPERATIONS) {
      expect(registeredStartOperationKind(operation)).toBe("query");
      expect(readPolicyFor(operation, "query")).toBe("strong");
    }
  });

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

  it("exposes only the selected database to an operation", () => {
    const strong = database("strong");
    const cached = database("cached");
    const context = { db: strong, readDb: cached, requestId: "request-1" };

    const ordinary = applyReadPolicy(context, "context");
    expect(ordinary).toMatchObject({ requestId: "request-1" });
    expect(ordinary.db).toBe(cached);
    expect(ordinary.readDb).toBe(cached);

    const authoritative = applyReadPolicy(context, "strong");
    expect(authoritative.db).toBe(strong);
    expect(authoritative.readDb).toBe(strong);
  });
});
