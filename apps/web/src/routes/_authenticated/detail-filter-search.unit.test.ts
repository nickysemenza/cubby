import { describe, expect, it } from "vitest";
import { mealCalendarSearchSchema } from "~/app/meals/meal-search";
import { expenseSearchSchema } from "./expenses.index";
import { financialAccountSearchSchema } from "./financial-accounts.index";
import { financialTransactionSearchSchema } from "./financial-transactions.index";
import { imageListSearchSchema } from "./images.index";
import { inventorySearchSchema } from "./inventory.index";
import { locationSearchSchema } from "./locations.index";
import { productSearchSchema } from "./products.index";
import { projectSearchSchema } from "./projects.index";
import { purchaseSearchSchema } from "./purchases.index";
import { recipeListSearchSchema } from "./recipes.index";
import { taskSearchSchema } from "./tasks.index";

describe("detail filter link route contracts", () => {
  it("keeps Product, Location, and exact Inventory facets across navigation", () => {
    expect(
      productSearchSchema.parse({
        view: "table",
        manufacturer: "Acme",
        model: "2853-20",
        category: "tools",
        tags: "M18",
        ingredient: "ING-4K7M",
      }),
    ).toMatchObject({
      view: "table",
      manufacturer: "Acme",
      model: "2853-20",
      category: "tools",
      tags: "M18",
      ingredient: "ING-4K7M",
    });

    expect(
      locationSearchSchema.parse({
        view: "table",
        type: "shelf",
        product: "PRD-4K7M",
        parent: "LOC-2ABC",
      }),
    ).toMatchObject({
      view: "table",
      type: "shelf",
      product: "PRD-4K7M",
      parent: "LOC-2ABC",
    });

    expect(
      inventorySearchSchema.parse({
        productId: "PRD-4K7M",
        locationId: "LOC-2ABC",
      }),
    ).toMatchObject({
      productId: "PRD-4K7M",
      locationId: "LOC-2ABC",
    });
  });

  it("keeps project and task cohort links on filter-aware renderers", () => {
    expect(
      projectSearchSchema.parse({
        view: "data",
        statuses: "planning,in_progress",
        kinds: ["garden", "renovation"],
        locations: "Home,Workshop",
        parent: "PRJ-4K7M",
      }),
    ).toMatchObject({
      view: "data",
      statuses: ["planning", "in_progress"],
      kinds: ["garden", "renovation"],
      locations: ["Home", "Workshop"],
      parent: "PRJ-4K7M",
    });

    expect(
      taskSearchSchema.parse({
        view: "list",
        status: "in_progress",
        trade: "electrical",
        project: "PRJ-4K7M",
        productId: "PRD-4K7M",
        parentTask: "TSK-2ABC",
      }),
    ).toMatchObject({
      view: "list",
      status: "in_progress",
      trade: "electrical",
      project: "PRJ-4K7M",
      productId: "PRD-4K7M",
      parentTask: "TSK-2ABC",
    });
  });

  it("keeps every linked Expense and Purchase facet", () => {
    expect(
      expenseSearchSchema.parse({
        lineKind: "principal",
        costType: "materials",
        trade: "plumbing",
        future: "true",
        vendor: "VEN-4K7M",
        project: "PRJ-4K7M",
        productId: "PRD-4K7M",
        lineBasis: "item_line",
      }),
    ).toMatchObject({
      lineKind: "principal",
      costType: "materials",
      trade: "plumbing",
      future: "true",
      vendor: "VEN-4K7M",
      project: "PRJ-4K7M",
      productId: "PRD-4K7M",
      lineBasis: "item_line",
    });

    expect(purchaseSearchSchema.parse({ vendor: "VEN-4K7M" })).toMatchObject({
      vendor: "VEN-4K7M",
    });
  });

  it("keeps Finance, Meal, Recipe, and Image facets", () => {
    expect(
      financialAccountSearchSchema.parse({
        identity: "credit_card",
        provisional: "true",
      }),
    ).toMatchObject({ identity: "credit_card", provisional: "true" });

    expect(
      financialTransactionSearchSchema.parse({
        merchant: "Hardware Store",
        kind: "purchase",
        status: "posted",
        accountId: "FAC-4K7M",
        purchaseId: "PUR-2ABC",
      }),
    ).toMatchObject({
      merchant: "Hardware Store",
      kind: "purchase",
      status: "posted",
      accountId: "FAC-4K7M",
      purchaseId: "PUR-2ABC",
    });

    expect(
      mealCalendarSearchSchema.parse({
        view: "table",
        mealType: "dinner",
        mealKind: "cooked",
      }),
    ).toMatchObject({
      view: "table",
      mealType: "dinner",
      mealKind: "cooked",
    });

    expect(
      recipeListSearchSchema.parse({
        tags: "weeknight",
        sourceType: "Book",
        source: "CKB-4K7M",
      }),
    ).toMatchObject({
      tags: "weeknight",
      sourceType: "Book",
      source: "CKB-4K7M",
    });

    expect(imageListSearchSchema.parse({ status: "UPLOADED" })).toMatchObject({
      status: "UPLOADED",
    });
  });

  it("rejects malformed enum, multi-value, and exact-inventory state", () => {
    expect(taskSearchSchema.safeParse({ status: "almost_done" }).success).toBe(
      false,
    );
    expect(
      projectSearchSchema.safeParse({ statuses: "planning,almost_done" })
        .success,
    ).toBe(false);
    expect(
      inventorySearchSchema.safeParse({ productId: "Milwaukee drill" }).success,
    ).toBe(false);
    expect(
      inventorySearchSchema.safeParse({ locationId: "LOC-0OIL" }).success,
    ).toBe(false);

    const malformedKnownValues = [
      [productSearchSchema, { category: "not_a_category" }],
      [productSearchSchema, { ingredient: "ingredient name" }],
      [locationSearchSchema, { type: "planet" }],
      [locationSearchSchema, { parent: "Kitchen" }],
      [projectSearchSchema, { parent: "Project name" }],
      [taskSearchSchema, { trade: "magic" }],
      [taskSearchSchema, { project: "Project name" }],
      [expenseSearchSchema, { lineKind: "subtotal" }],
      [expenseSearchSchema, { costType: "unknown" }],
      [expenseSearchSchema, { lineBasis: "guess" }],
      [expenseSearchSchema, { future: "maybe" }],
      [purchaseSearchSchema, { vendor: "Vendor name" }],
      [financialAccountSearchSchema, { identity: "mortgage" }],
      [financialAccountSearchSchema, { provisional: "maybe" }],
      [financialTransactionSearchSchema, { kind: "withdrawal" }],
      [financialTransactionSearchSchema, { status: "settled" }],
      [financialTransactionSearchSchema, { accountId: "Visa" }],
      [mealCalendarSearchSchema, { mealType: "supper" }],
      [mealCalendarSearchSchema, { mealKind: "delivery" }],
      [recipeListSearchSchema, { sourceType: "Magazine" }],
      [recipeListSearchSchema, { source: "Joy of Cooking" }],
      [imageListSearchSchema, { status: "PROCESSING" }],
    ] as const;

    for (const [schema, search] of malformedKnownValues) {
      expect(schema.safeParse(search).success, JSON.stringify(search)).toBe(
        false,
      );
    }
  });
});
