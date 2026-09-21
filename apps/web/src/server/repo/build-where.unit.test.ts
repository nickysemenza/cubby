import type { FinancialAccountFilters } from "@cubby/schemas/financial-account";
import type { FinancialTransactionFilters } from "@cubby/schemas/financial-transaction";
import type { ImageListFilters } from "@cubby/schemas/image";
import {
  type IngredientFilters,
  ingredientFiltersSchema,
} from "@cubby/schemas/ingredient";
import {
  type LedgerPartyFilters,
  ledgerPartyFiltersSchema,
} from "@cubby/schemas/ledger-party";
import type { MealFilters } from "@cubby/schemas/meal";
import type { ProductFilters } from "@cubby/schemas/product";
import type { ExpenseFilters, ProjectFilters } from "@cubby/schemas/project";
import type { PurchaseFilters } from "@cubby/schemas/purchase";
import type { VendorFilters } from "@cubby/schemas/vendor";
import type { WishFilters } from "@cubby/schemas/wish";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildExpenseWhereClause } from "./expense/lookup";
import { buildFinancialAccountWhere } from "./financial-account";
import { buildFinancialTransactionWhere } from "./financial-transaction";
import { buildImageWhere } from "./image";
import { buildIngredientListWhere } from "./ingredient/search";
import { buildLedgerPartyWhere } from "./ledger-party";
import { buildLocationWhere } from "./location/crud";
import type { LocationFilters } from "./location/internal-types";
import { buildMealWhere } from "./meal/crud";
import { buildProductWhere } from "./product/crud";
import { buildProjectWhere } from "./project/lookup";
import { buildPurchaseWhereClause } from "./purchase";
import { buildRecipeWhere } from "./recipe/crud";
import type { RecipeFilters } from "./recipe/internal-types";
import { buildVendorWhereClause } from "./vendor";
import { buildWishWhere } from "./wish";

/**
 * Table-driven consolidation of the 14 per-entity `build<Entity>Where` test
 * files (B1). The "no filters -> defined base predicate" case that every one
 * of those files repeated is dropped: `declared-filter-predicates.unit.test.ts`
 * already loops every stored entity with `{}` and asserts every predicate is
 * `undefined`, which is exactly what that case guarded.
 */

describe("buildWishWhere", () => {
  const where = (filters: WishFilters) =>
    buildWishWhere(mockWhereDatabase(), filters).then(renderWhereSql);

  it.each([
    {
      name: "acquired=true",
      filters: { acquired: true },
      contains: '"acquiredAt" is not null',
    },
    {
      name: "acquired=false",
      filters: { acquired: false },
      contains: '"acquiredAt" is null',
    },
  ])(
    "reads acquired as presence of acquiredAt ($name, declared stored boolean)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );
});

describe("buildFinancialAccountWhere", () => {
  const where = (filters: FinancialAccountFilters) =>
    Promise.resolve(renderWhereSql(buildFinancialAccountWhere(filters)));

  it.each([
    { name: "name", filters: { search: "checking" }, contains: '"name"' },
    {
      name: "provisional",
      filters: { provisional: true },
      contains: '"provisional"',
    },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );
});

describe("buildFinancialTransactionWhere", () => {
  const where = (filters: FinancialTransactionFilters) =>
    buildFinancialTransactionWhere(mockWhereDatabase(), filters).then(
      renderWhereSql,
    );

  it("matches merchant OR raw description (declared stored text filter)", async () => {
    // Regression: the hand-written version ANDed the two columns, so a term
    // had to appear in both to match.
    expect(await where({ search: "coffee" })).toMatch(
      /"merchant" ilike \$\d+ or "FinancialTransaction"\."rawDescription" ilike/u,
    );
  });

  it.each([
    { name: "amountMin", filters: { amountMin: 0 }, contains: '"amount" >=' },
    { name: "amountMax", filters: { amountMax: 0 }, contains: '"amount" <=' },
    {
      name: "transactionDateFrom",
      filters: { transactionDateFrom: "2026-01-01" },
      contains: '"transactionDate" >=',
    },
    {
      name: "kind",
      filters: { kind: "purchase" } as const,
      contains: '"kind"',
    },
    {
      name: "status",
      filters: { status: "posted" } as const,
      contains: '"status"',
    },
    { name: "merchant", filters: { merchant: "acme" }, contains: '"merchant"' },
    {
      name: "postedDateFrom",
      filters: { postedDateFrom: "2026-01-01" },
      contains: '"postedDate"',
    },
    {
      name: "postedDateTo",
      filters: { postedDateTo: "2026-01-01" },
      contains: '"postedDate"',
    },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );
});

describe("buildImageWhere", () => {
  const where = (filters: ImageListFilters) =>
    Promise.resolve(
      renderWhereSql(buildImageWhere(mockWhereDatabase(), filters)),
    );

  it.each([
    {
      name: "filename",
      filters: { nameFilter: "receipt" },
      contains: '"filename"',
    },
    {
      name: "status",
      filters: { status: "UPLOADED" } as const,
      contains: '"status"',
    },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );
});

describe("buildLedgerPartyWhere", () => {
  // Parsed rather than asserted: the related-view filter trios carry branded
  // shortcodes, and every filter field is optional, so the schema accepts
  // the partial set under test.
  const where = (filters: Partial<LedgerPartyFilters>) =>
    Promise.resolve(
      renderWhereSql(
        buildLedgerPartyWhere(ledgerPartyFiltersSchema.parse(filters)),
      ),
    );

  it.each([
    { name: "kind", filters: { kind: "member" } as const, contains: '"kind"' },
    { name: "name", filters: { search: "Alex" }, contains: '"name"' },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );

  it("trims a whitespace-only search to no filter", async () => {
    expect(await where({ search: "   " })).toBe(await where({}));
  });
});

describe("buildPurchaseWhereClause", () => {
  const where = (filters: PurchaseFilters) =>
    buildPurchaseWhereClause(mockWhereDatabase(), filters).then(renderWhereSql);

  it("searches order id or label (declared stored)", async () => {
    const rendered = await where({ search: "order" });
    expect(rendered).toContain('"orderId" ilike');
    expect(rendered).toContain('"displayLabel" ilike');
  });

  it.each([
    {
      name: "statedTotalPresenceFilter",
      filters: { statedTotalPresenceFilter: "none" } as const,
      contains: '"statedTotal" is null',
    },
    {
      name: "dateTo",
      filters: { dateTo: "2026-01-31" },
      contains: '"date" <=',
    },
    {
      name: "displayLabelSearch",
      filters: { displayLabelSearch: "invoice" },
      contains: '"displayLabel"',
    },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );
});

describe("buildVendorWhereClause", () => {
  const where = (filters: VendorFilters) =>
    Promise.resolve(renderWhereSql(buildVendorWhereClause(filters)));

  it("matches name, notes, or website (declared stored text filter)", async () => {
    const rendered = await where({ search: "hardware" });
    expect(rendered).toContain('"name"');
    expect(rendered).toContain('"notes"');
    expect(rendered).toContain('"website"');
  });
});

describe("buildLocationWhere", () => {
  // SAFETY: test-only partial filter set; buildLocationWhere only reads the
  // keys under test, so a partial object is safe to pass here.
  const where = (filters: Partial<LocationFilters>) =>
    buildLocationWhere(mockWhereDatabase(), filters as LocationFilters).then(
      renderWhereSql,
    );

  it.each([
    {
      name: "type",
      filters: { itemTypeFilter: "shelf" } as const,
      contains: '"type"',
    },
    {
      name: "AI description presence",
      filters: { aiDescriptionPresenceFilter: "has" } as const,
      contains: '"aiDescription" is not null',
    },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );

  it("matches name, AI description, and aliases by element (declared stored text filter)", async () => {
    const rendered = await where({ nameFilter: "attic" });
    expect(rendered).toContain('"name"');
    expect(rendered).toContain('"aiDescription"');
    expect(rendered).toContain('unnest("Location"."aliases")');
  });
});

describe("buildRecipeWhere", () => {
  const where = (filters: RecipeFilters) =>
    buildRecipeWhere(mockWhereDatabase(), filters).then(renderWhereSql);

  it("matches name or notes (declared stored text filter)", async () => {
    const rendered = await where({ nameFilter: "soup" });
    expect(rendered).toContain('"name"');
    expect(rendered).toContain('"notes"');
  });

  it("overlaps tags and ORs the untagged sentinel (declared stored array filter)", async () => {
    expect(await where({ tagFilters: ["quick"] })).toContain('"tags" &&');
    expect(await where({ tagFilters: "quick" })).toContain('"tags" &&');
    // `tags` is nullable, so untagged means NULL or zero-length.
    expect(await where({ tagsPresenceFilter: "none" })).toContain(
      '"tags" IS NULL OR cardinality("Recipe"."tags") = 0',
    );
  });

  it.each([
    {
      name: "totalMinutesMin",
      filters: { totalMinutesMin: 10 },
      contains: '"totalMinutes"',
    },
    {
      name: "totalMinutesMax",
      filters: { totalMinutesMax: 60 },
      contains: '"totalMinutes"',
    },
  ])(
    "still narrows by $name (declared stored numeric range filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );
});

describe("buildProductWhere", () => {
  const where = (filters: ProductFilters) =>
    buildProductWhere(mockWhereDatabase(), filters).then(renderWhereSql);

  it.each([
    { name: "name", filters: { nameFilter: "flour" }, contains: '"name"' },
    { name: "model", filters: { modelFilter: "DCD" }, contains: '"model"' },
    { name: "notes", filters: { notesFilter: "gift" }, contains: '"notes"' },
    {
      name: "category",
      filters: { categoryFilter: "food" } as const,
      contains: '"category"',
    },
    {
      name: "category presence",
      filters: { categoryPresenceFilter: "none" } as const,
      contains: '"category"',
    },
    {
      name: "manufacturerExact",
      filters: { manufacturerExact: "DeWalt" },
      contains: '"manufacturer"',
    },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );

  it("overlaps tags with a cardinality sentinel and reads presence filters (declared stored)", async () => {
    expect(await where({ tagFilters: ["tool"] })).toContain('"tags" &&');
    // `tags` is NOT NULL with a `{}` default, so untagged is zero-length only.
    expect(await where({ tagsPresenceFilter: "none" })).toContain(
      '(cardinality("Product"."tags") = 0)',
    );
    expect(await where({ modelPresenceFilter: "has" })).toContain(
      '"model" is not null',
    );
    expect(await where({ notesPresenceFilter: "none" })).toContain(
      '"notes" is null',
    );
    expect(await where({ stockTrackedPresenceFilter: "none" })).toContain(
      '"stockTracked" is null',
    );
  });
});

describe("buildMealWhere", () => {
  const where = (filters: MealFilters) =>
    Promise.resolve(
      renderWhereSql(buildMealWhere(mockWhereDatabase(), filters)),
    );

  it.each([
    {
      name: "mealType",
      filters: { mealType: "dinner" } as const,
      contains: '"mealType"',
    },
    {
      name: "mealType presence",
      filters: { mealTypePresenceFilter: "none" } as const,
      contains: '"mealType"',
    },
    {
      name: "mealKind",
      filters: { mealKind: "cooked" } as const,
      contains: '"mealKind"',
    },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );

  it("recipeCostCoverage=understated matches partial and unavailable costs that recorded contributors", async () => {
    const rendered = await where({ recipeCostCoverage: "understated" });
    expect(rendered).toContain("'partial'");
    expect(rendered).toContain("'unavailable'");
    expect(rendered).toContain("{cost,coverage,total}");
    // The subselect joins two tables, so the JSON column must stay qualified.
    expect(rendered).toMatch(
      /"Recipe"\."totals" #>> '\{cost,coverage,total\}'/,
    );
  });
});

describe("buildProjectWhere", () => {
  const where = (filters: ProjectFilters) =>
    buildProjectWhere(mockWhereDatabase(), filters).then(renderWhereSql);

  it.each([
    {
      name: "status",
      filters: { status: "done" } as const,
      contains: '"status"',
    },
    {
      name: "kind",
      filters: { kind: "furniture" } as const,
      contains: '"kind"',
    },
    {
      name: "location",
      filters: { location: "Garage" },
      contains: '"locationsMode"',
    },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );

  it("matches project-owned name and notes while inherited locations use their dedicated filter", async () => {
    const rendered = await where({ search: "shed" });
    expect(rendered).toContain('"name"');
    expect(rendered).toContain('"notes"');
    expect(rendered).not.toContain('unnest("Project"."locations")');
  });
});

describe("buildIngredientListWhere", () => {
  // Parsed rather than asserted: the related-view filter trios carry branded
  // shortcodes, and every filter field is optional, so the schema accepts
  // the partial set under test.
  const where = (filters: Partial<IngredientFilters>) =>
    buildIngredientListWhere(
      mockWhereDatabase(),
      ingredientFiltersSchema.parse(filters),
    ).then(renderWhereSql);

  it.each([
    {
      name: "usuallyOnHand=true",
      filters: { usuallyOnHand: true },
      contains: '"usuallyOnHand"',
    },
    {
      name: "usuallyOnHand=false",
      filters: { usuallyOnHand: false },
      contains: '"usuallyOnHand"',
    },
  ])(
    "still narrows by $name (declared stored boolean filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );
});

describe("buildExpenseWhereClause", () => {
  const where = (filters: ExpenseFilters) =>
    buildExpenseWhereClause(mockWhereDatabase(), filters).then(renderWhereSql);

  it.each([
    {
      name: "dateFrom",
      filters: { dateFrom: "2026-01-01" },
      contains: '"date" >=',
    },
    // Zero is a meaningful bound: `costMax: 0` is the credits-only worklist.
    { name: "costMax", filters: { costMax: 0 }, contains: '"cost" <=' },
    { name: "costMin", filters: { costMin: 0 }, contains: '"cost" >=' },
    {
      name: "productQuantityMax",
      filters: { productQuantityMax: -1 },
      contains: '"productQuantity" <=',
    },
    {
      name: "notesSearch",
      filters: { notesSearch: "refund" },
      contains: '"notes" ilike',
    },
    {
      name: "urlSearch",
      filters: { urlSearch: "example" },
      contains: '"url" ilike',
    },
    {
      name: "lineKind",
      filters: { lineKind: "tax" } as const,
      contains: '"lineKind"',
    },
    {
      name: "lineBasis",
      filters: { lineBasis: "item_line" } as const,
      contains: '"lineBasis"',
    },
    {
      name: "costType",
      filters: { costType: "materials" } as const,
      contains: '"costType"',
    },
    {
      name: "trade",
      filters: { trade: "electrical" } as const,
      contains: '"trade"',
    },
    { name: "future", filters: { future: true }, contains: '"future"' },
  ])(
    "still narrows by $name (declared stored filter)",
    async ({ filters, contains }) => {
      expect(await where(filters)).toContain(contains);
    },
  );
});
