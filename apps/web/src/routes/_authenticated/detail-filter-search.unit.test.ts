import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { describe, expect, it } from "vitest";

import { entitySearch } from "~/entities/generated/entity-search.gen";

describe("detail filter link route contracts", () => {
  it("keeps Product, Location, and exact Inventory facets across navigation", () => {
    expect(
      entitySearch.product.schema.parse({
        manufacturer: "Acme",
        model: "2853-20",
        category: "CAT-2224",
        tags: "M18",
        ingredient: "ING-4K7M",
        location: "LOC-2ABC,__none__",
      }),
    ).toMatchObject({
      manufacturer: "Acme",
      model: "2853-20",
      category: "CAT-2224",
      tags: "M18",
      ingredient: "ING-4K7M",
      location: "LOC-2ABC,__none__",
    });

    expect(
      entitySearch.location.schema.parse({
        type: "shelf",
        product: "PRD-4K7M",
        parent: "LOC-2ABC",
      }),
    ).toMatchObject({
      type: "shelf",
      product: "PRD-4K7M",
      parent: "LOC-2ABC",
    });

    expect(
      entitySearch.inventory.schema.parse({
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
      entitySearch.project.schema.parse({
        statuses: "planning,in_progress",
        kinds: "garden,renovation",
        locations: "Home,Workshop",
        parent: "PRJ-4K7M",
      }),
    ).toMatchObject({
      statuses: "planning,in_progress",
      kinds: "garden,renovation",
      locations: "Home,Workshop",
      parent: "PRJ-4K7M",
    });

    expect(
      entitySearch.task.schema.parse({
        status: "in_progress",
        trade: "electrical",
        project: "PRJ-4K7M",
        productId: "PRD-4K7M",
        parentTask: "TSK-2ABC",
      }),
    ).toMatchObject({
      status: "in_progress",
      trade: "electrical",
      project: "PRJ-4K7M",
      productId: "PRD-4K7M",
      parentTask: "TSK-2ABC",
    });
  });

  it("keeps every linked Expense and Purchase facet", () => {
    expect(
      entitySearch.expense.schema.parse({
        lineKind: "principal",
        costType: "materials",
        trade: "plumbing",
        future: "true",
        vendor: "VEN-4K7M",
        project: "PRJ-4K7M",
        productId: "PRD-4K7M",
        lineBasis: "item_line",
        create: true,
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
      create: true,
    });

    expect(
      entitySearch.purchase.schema.parse({ vendor: "VEN-4K7M" }),
    ).toMatchObject({ vendor: "VEN-4K7M" });
  });

  it("keeps Finance, Meal, Recipe, and Image facets", () => {
    expect(
      entitySearch.financialAccount.schema.parse({
        identity: "credit_card",
        provisional: "true",
      }),
    ).toMatchObject({ identity: "credit_card", provisional: "true" });

    expect(
      entitySearch.financialTransaction.schema.parse({
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
      entitySearch.meal.schema.parse({
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
      entitySearch.recipe.schema.parse({
        tags: "weeknight",
        sourceType: "Book",
        source: "CKB-4K7M",
      }),
    ).toMatchObject({
      tags: "weeknight",
      sourceType: "Book",
      source: "CKB-4K7M",
    });

    expect(
      entitySearch.image.schema.parse({ status: "UPLOADED" }),
    ).toMatchObject({ status: "UPLOADED" });
  });

  it("exposes each entity's literal filter keys to typed links", () => {
    const product = entitySearch.product.schema.parse({ manufacturer: "Acme" });
    const location = entitySearch.location.schema.parse({ type: "shelf" });
    const task = entitySearch.task.schema.parse({ status: "in_progress" });

    // Property access is the assertion here: the keys survive in the *type* —
    // where `Route.useSearch()` and `<Link search>` read them — because the
    // generated schema spells every key as a literal.
    expect(product.manufacturer).toBe("Acme");
    expect(product.model).toBeUndefined();
    expect(product.tags).toBeUndefined();
    expect(location.type).toBe("shelf");
    expect(task.status).toBe("in_progress");
  });

  it("names every schema key in defaults so stripSearchParams sees them all", () => {
    for (const { schema, defaults } of Object.values(entitySearch)) {
      expect(Object.keys(defaults)).toEqual(Object.keys(schema.shape));
      expect(
        Object.values(defaults).every((value) => value === undefined),
      ).toBe(true);
    }
  });

  it("keeps malformed filters safe without widening exact entity scopes", () => {
    const malformedKnownValues = [
      [entitySearch.task.schema, { status: "almost_done" }, undefined],
      [
        entitySearch.product.schema,
        { category: "not_a_category" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [
        entitySearch.product.schema,
        { ingredient: "ingredient name" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [entitySearch.location.schema, { type: "planet" }, undefined],
      [
        entitySearch.location.schema,
        { parent: "Kitchen" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [
        entitySearch.project.schema,
        { statuses: "planning,almost_done" },
        undefined,
      ],
      [
        entitySearch.project.schema,
        { parent: "Project name" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [entitySearch.task.schema, { trade: "magic" }, undefined],
      [
        entitySearch.task.schema,
        { project: "Project name" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [entitySearch.expense.schema, { lineKind: "subtotal" }, undefined],
      [entitySearch.expense.schema, { costType: "unknown" }, undefined],
      [entitySearch.expense.schema, { lineBasis: "guess" }, undefined],
      [
        entitySearch.purchase.schema,
        { vendor: "Vendor name" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [
        entitySearch.financialAccount.schema,
        { identity: "mortgage" },
        undefined,
      ],
      [
        entitySearch.financialTransaction.schema,
        { kind: "withdrawal" },
        undefined,
      ],
      [
        entitySearch.financialTransaction.schema,
        { status: "settled" },
        undefined,
      ],
      [
        entitySearch.financialTransaction.schema,
        { accountId: "Visa" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [entitySearch.meal.schema, { mealType: "supper" }, undefined],
      [entitySearch.meal.schema, { mealKind: "delivery" }, undefined],
      [entitySearch.recipe.schema, { sourceType: "Magazine" }, undefined],
      [
        entitySearch.recipe.schema,
        { source: "Joy of Cooking" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [entitySearch.image.schema, { status: "PROCESSING" }, undefined],
      [
        entitySearch.inventory.schema,
        { productId: "Milwaukee drill" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
      [
        entitySearch.inventory.schema,
        { locationId: "LOC-0OIL" },
        UNRESOLVABLE_ENTITY_FILTER,
      ],
    ] as const;

    for (const [schema, search, expected] of malformedKnownValues) {
      const result = schema.safeParse(search);
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(result.success, JSON.stringify(search)).toBe(true);
      if (!result.success) continue;
      for (const key of Object.keys(search)) {
        const actual = Object.entries(result.data).find(
          ([parsedKey]) => parsedKey === key,
        )?.[1];
        expect(actual, `${JSON.stringify(search)}: ${key}`).toBe(expected);
      }
    }
  });
});
