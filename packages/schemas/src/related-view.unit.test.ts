import { describe, expect, it } from "vitest";
import { entityManifest } from "./entity-manifest";
import { financialAccountFilterFields } from "./financial-account";
import { financialTransactionFilterFields } from "./financial-transaction";
import { ingredientFilterFields } from "./ingredient";
import { inventoryFilterFields } from "./inventory";
import { ledgerPartyFilterFields } from "./ledger-party";
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
  relatedViewPath,
  relatedSummaryInput,
  relatedSummaryOutput,
  relatedSummaryRelationKeys,
  type RelatedViewDefinition,
  relatedViewRegistry,
} from "./related-view";
import { vendorFilterFields } from "./vendor";
import { wishFilterFields } from "./wish";

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
  it("accepts only the curated expense-backed summary relations", () => {
    expect(relatedSummaryRelationKeys).toEqual([
      "vendor.products",
      "vendor.projects",
      "purchase.projects",
      "project.vendors",
      "project.purchasedProducts",
      "product.vendors",
    ]);
    expect(
      relatedSummaryInput.parse({
        relationKey: "vendor.products",
        sourceId: "VEN-ABCD",
      }),
    ).toMatchObject({ offset: 0, limit: 25 });
    expect(
      () =>
        relatedSummaryInput.parse({
          relationKey: "vendor.purchases",
          sourceId: "VEN-ABCD",
        }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
    expect(
      relatedSummaryOutput.parse({
        data: [],
        count: 0,
        totals: {
          expenseCount: 0,
          purchaseCount: 0,
          unpricedExpenseCount: 0,
          itemSpend: 0,
          sharedChargeSpend: 0,
          netSpend: 0,
          incomplete: false,
          knownAcquiredUnits: 0,
          unknownAcquisitionQuantityCount: 0,
        },
        nextOffset: null,
      }),
    ).toBeTruthy();
    expect(
      () =>
        relatedSummaryInput.parse({
          relationKey: "vendor.products",
          sourceId: "VEN-ABCD",
          extra: true,
        }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
    expect(
      () =>
        relatedSummaryOutput.parse({
          data: [],
          count: 0,
          totals: {
            expenseCount: 0,
            purchaseCount: 0,
            unpricedExpenseCount: 0,
            itemSpend: 0,
            sharedChargeSpend: 0,
            netSpend: 0,
            incomplete: false,
            knownAcquiredUnits: 0,
            unknownAcquisitionQuantityCount: 0,
          },
          nextOffset: null,
          extra: true,
        }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
  });

  it("has unique, source-prefixed keys and only curated 1-4 hop paths", () => {
    const keys = relatedViewRegistry.map((view) => view.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const view of relatedViewRegistry) {
      const path = relatedViewPath(view);
      expect(view.key.startsWith(`${view.source}.`)).toBe(true);
      expect(path.length).toBeGreaterThanOrEqual(1);
      // 4, not 3, since FinancialTransactionAllocation landed: a transaction
      // reaches a Purchase through a join table now, so every path crossing
      // that relationship costs two hops rather than one. The ceiling still
      // exists to stop a related view becoming an arbitrary graph walk — it is
      // just that the shortest honest route across this edge is longer than it
      // used to be.
      expect(path.length).toBeLessThanOrEqual(4);
      expect(view.source).not.toBe("usda-food");
      expect(view.source).not.toBe("image");
    }
  });

  it("uses only edges verified by the canonical entity graph", () => {
    for (const view of relatedViewRegistry) {
      for (const step of relatedViewPath(view)) {
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
      ingredient: ingredientFilterFields,
      ledgerParty: ledgerPartyFilterFields,
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
      wish: wishFilterFields,
    } as const;
    for (const view of relatedViewRegistry) {
      const prefix = relatedFilterPrefix(view);
      expect(fields[view.source]).toHaveProperty(`${prefix}Id`);
      expect(fields[view.source]).toHaveProperty(`${prefix}PresenceFilter`);
      expect(fields[view.source]).toHaveProperty(`${prefix}Search`);
    }
  });
});
