import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { describe, expect, it } from "vitest";

import { mealCalendarSearchSchema } from "~/app/meals/meal-search";
import {
  expenseSearchSchema,
  financialAccountSearchSchema,
  financialTransactionSearchSchema,
  imageListSearchSchema,
  inventorySearchSchema,
  locationSearchSchema,
  productSearchSchema,
  projectSearchSchema,
  purchaseSearchSchema,
  recipeListSearchSchema,
  taskSearchSchema,
} from "~/entities/list-search";

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
        productId: "prd-4k7m",
        locationId: " loc-2abc ",
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

  it("exposes each entity's literal filter keys to typed links", () => {
    const product = productSearchSchema.parse({ manufacturer: "Acme" });
    const location = locationSearchSchema.parse({ type: "shelf" });
    const task = taskSearchSchema.parse({ status: "in_progress" });

    // Property access is the assertion here. At runtime these keys come from a
    // computed `Record<string, …>`; they only survive in the *type* — where
    // `Route.useSearch()` and `<Link search>` read them — because
    // `listSearchSchema` keeps its overrides a literal type parameter.
    expect(product.manufacturer).toBe("Acme");
    expect(product.model).toBeUndefined();
    expect(product.tags).toBeUndefined();
    expect(location.type).toBe("shelf");
    expect(task.status).toBe("in_progress");
  });

  it("keeps malformed filters safe without widening exact entity scopes", () => {
    expect(
      projectSearchSchema.safeParse({ statuses: "planning,almost_done" })
        .success,
    ).toBe(false);

    const malformedKnownValues = [
      [taskSearchSchema, { status: "almost_done" }, undefined],
      [productSearchSchema, { category: "not_a_category" }, undefined],
      [
        productSearchSchema,
        { ingredient: "ingredient name" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [locationSearchSchema, { type: "planet" }, undefined],
      [locationSearchSchema, { parent: "Kitchen" }, UNRESOLVABLE_ENTITY_FILTER],
      [
        projectSearchSchema,
        { parent: "Project name" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [taskSearchSchema, { trade: "magic" }, undefined],
      [
        taskSearchSchema,
        { project: "Project name" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [expenseSearchSchema, { lineKind: "subtotal" }, undefined],
      [expenseSearchSchema, { costType: "unknown" }, undefined],
      [expenseSearchSchema, { lineBasis: "guess" }, undefined],
      [expenseSearchSchema, { future: "maybe" }, undefined],
      [
        purchaseSearchSchema,
        { vendor: "Vendor name" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [financialAccountSearchSchema, { identity: "mortgage" }, undefined],
      [financialAccountSearchSchema, { provisional: "maybe" }, undefined],
      [financialTransactionSearchSchema, { kind: "withdrawal" }, undefined],
      [financialTransactionSearchSchema, { status: "settled" }, undefined],
      [
        financialTransactionSearchSchema,
        { accountId: "Visa" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [mealCalendarSearchSchema, { mealType: "supper" }, undefined],
      [mealCalendarSearchSchema, { mealKind: "delivery" }, undefined],
      [recipeListSearchSchema, { sourceType: "Magazine" }, undefined],
      [
        recipeListSearchSchema,
        { source: "Joy of Cooking" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [imageListSearchSchema, { status: "PROCESSING" }, undefined],
      [
        inventorySearchSchema,
        { productId: "Milwaukee drill" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [
        inventorySearchSchema,
        { locationId: "LOC-0OIL" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
    ] as const;

    for (const [schema, search, expected] of malformedKnownValues) {
      const result = schema.safeParse(search);
      expect(result.success, JSON.stringify(search)).toBe(true);
      if (!result.success) continue;
      const parsedSearch = result.data as Record<string, unknown>;
      for (const key of Object.keys(search)) {
        expect(parsedSearch[key], `${JSON.stringify(search)}: ${key}`).toBe(
          expected,
        );
      }
    }
  });
});
