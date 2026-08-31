import { describe, expect, it } from "vitest";

import { registeredStartOperationKind } from "~/lib/start-operation-observability";
import { Database } from "~/server/db";

import {
  applyBrowserReadPolicy,
  browserReadPolicyFor,
  STRONG_BROWSER_QUERY_OPERATIONS,
} from "./browser-read-policy";

const database = (label: string) =>
  new Database(() => {
    throw new Error(`${label} must not resolve during policy tests`);
  });

describe("browser read policy", () => {
  it("keeps every registry member query-shaped and strong", () => {
    expect(new Set(STRONG_BROWSER_QUERY_OPERATIONS).size).toBe(
      STRONG_BROWSER_QUERY_OPERATIONS.length,
    );

    for (const operation of STRONG_BROWSER_QUERY_OPERATIONS) {
      expect(registeredStartOperationKind(operation)).toBe("query");
      expect(browserReadPolicyFor(operation, "query")).toBe("strong");
    }
  });

  it("uses bounded-stale context for representative display reads", () => {
    for (const operation of [
      "calendar.range",
      "collection.detail",
      "cookbook.detail",
      "dashboard.counts",
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
      expect(browserReadPolicyFor(operation, "query")).toBe("context");
    }
  });

  it("makes every mutation strong regardless of its operation family", () => {
    expect(browserReadPolicyFor("entity.mutate", "mutation")).toBe("strong");
    expect(browserReadPolicyFor("calendar.rotateFeed", "mutation")).toBe(
      "strong",
    );
  });

  it("exposes only the selected database to an operation", () => {
    const strong = database("strong");
    const cached = database("cached");
    const context = { db: strong, readDb: cached, requestId: "request-1" };

    const ordinary = applyBrowserReadPolicy(context, "context");
    expect(ordinary).toMatchObject({ requestId: "request-1" });
    expect(ordinary.db).toBe(cached);
    expect(ordinary.readDb).toBe(cached);

    const authoritative = applyBrowserReadPolicy(context, "strong");
    expect(authoritative.db).toBe(strong);
    expect(authoritative.readDb).toBe(strong);
  });
});
