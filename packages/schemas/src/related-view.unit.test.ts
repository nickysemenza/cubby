import { describe, expect, it } from "vitest";
import { entityManifest } from "./entity-manifest";
import { financialAccountFilterFields } from "./financial-account";
import { financialTransactionFilterFields } from "./financial-transaction";
import { inventoryFilterFields } from "./inventory";
import { locationFilterFields } from "./location";
import { mealFilterFields } from "./meal";
import { productFilterFields } from "./product";
import {
  expenseFilterFields,
  projectFilterFields,
  taskFilterFields,
} from "./project";
import { purchaseFilterFields } from "./purchase";
import { recipeFilterFields } from "./recipe";
import {
  relatedFilterPrefix,
  type RelatedViewDefinition,
  relatedViewRegistry,
} from "./related-view";
import { vendorFilterFields } from "./vendor";

const declaredLocalEdges = new Set(
  Object.values(entityManifest).flatMap((descriptor) =>
    descriptor.relationships.flatMap((relationship) =>
      relationship.provenance.kind === "local-path"
        ? relationship.provenance.steps.map((step) => step.edge)
        : [],
    ),
  ),
);

describe("relatedViewRegistry", () => {
  it("has unique, source-prefixed keys and only curated 1-3 hop paths", () => {
    const keys = relatedViewRegistry.map((view) => view.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const view of relatedViewRegistry) {
      expect(view.key.startsWith(`${view.source}.`)).toBe(true);
      expect(view.path.length).toBeGreaterThanOrEqual(1);
      expect(view.path.length).toBeLessThanOrEqual(3);
      expect(view.source).not.toBe("usda-food");
      expect(view.source).not.toBe("image");
    }
  });

  it("uses only edges verified by the canonical entity graph", () => {
    for (const view of relatedViewRegistry) {
      for (const step of view.path) {
        expect(declaredLocalEdges, `${view.key}: ${step.edge}`).toContain(
          step.edge,
        );
      }
    }
  });

  it("keeps declared inverse paths directional and reciprocal", () => {
    const views: readonly RelatedViewDefinition[] = relatedViewRegistry;
    const byKey = new Map(views.map((view) => [view.key, view]));
    for (const view of views) {
      if (!view.inverseKey) continue;
      const inverse = byKey.get(view.inverseKey);
      expect(inverse, `${view.key}: ${view.inverseKey}`).toBeDefined();
      expect(inverse?.source).toBe(view.target);
      expect(inverse?.target).toBe(view.source);
      expect(inverse?.inverseKey).toBe(view.key);
    }
  });

  it("keeps the finance acceptance columns visible by default", () => {
    const visible = new Set(
      relatedViewRegistry
        .filter((view) => view.defaultVisible)
        .map((view) => view.key),
    );
    expect(visible).toContain("vendor.expenses");
    expect(visible).toContain("purchase.expenses");
    expect(visible).toContain("purchase.transactions");
    expect(visible).toContain("financialAccount.transactions");
  });

  it("exposes an exact-id, presence, and terminal-search field for every path", () => {
    const fields = {
      product: productFilterFields,
      recipe: recipeFilterFields,
      location: locationFilterFields,
      inventory: inventoryFilterFields,
      meal: mealFilterFields,
      project: projectFilterFields,
      task: taskFilterFields,
      vendor: vendorFilterFields,
      purchase: purchaseFilterFields,
      expense: expenseFilterFields,
      financialAccount: financialAccountFilterFields,
      financialTransaction: financialTransactionFilterFields,
    } as const;
    for (const view of relatedViewRegistry) {
      const prefix = relatedFilterPrefix(view);
      expect(fields[view.source]).toHaveProperty(`${prefix}Id`);
      expect(fields[view.source]).toHaveProperty(`${prefix}PresenceFilter`);
      expect(fields[view.source]).toHaveProperty(`${prefix}Search`);
    }
  });
});
