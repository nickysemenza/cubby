import { randomUUID } from "node:crypto";

import {
  parseEntityId,
  parseShortcodeFor,
  type ProductCategoryId,
  type ProductId,
  type ProjectId,
  type PurchaseId,
  type SpendingCategoryId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import {
  expense as expenseTable,
  product as productTable,
  productCategory,
  project as projectTable,
  purchase,
  spendingCategory,
  vendor,
} from "~/server/db/schema";
import {
  expenseSpendingCategoryResolutionSql,
  type ExpenseSpendingCategoryResolutionDraft,
} from "~/server/domains/expense/repo/expense-category-resolution";
import {
  loadExpenseJointAllocations,
  type ExpenseJointAllocationRow,
} from "~/server/domains/expense/repo/expense-project-allocation";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import type { EntityPayloadValues } from "~/server/entity-kernel/repo/entity-identity-writer";
import { insertEntityFixtures } from "~/server/testing/repo.fixtures";

import { previewSpendingClassificationReview } from "./spending-classification-review";

type SeededEntity =
  | "spendingCategory"
  | "productCategory"
  | "product"
  | "vendor"
  | "purchase"
  | "expense"
  | "project";
const PREFIX = {
  spendingCategory: "SPC-",
  productCategory: "CAT-",
  product: "PRD-",
  vendor: "VEN-",
  purchase: "PUR-",
  expense: "EXP-",
  project: "PRJ-",
} as const satisfies Record<SeededEntity, string>;
const CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Deterministic `ZZ…` identities, clear of the template's random shortcodes. */
function identity<E extends SeededEntity>(entity: E, index: number) {
  let body = "";
  for (let value = index, digit = 0; digit < 3; digit++) {
    body = `${CHARS[value % CHARS.length]}${body}`;
    value = Math.floor(value / CHARS.length);
  }
  return {
    id: parseEntityId(entity, randomUUID()),
    shortcode: parseShortcodeFor(entity, `${PREFIX[entity]}ZZ${body}`),
  };
}

// Seeded mulberry32: the same synthetic household on every run.
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(next() * values.length)];
    if (value === undefined) throw new Error("Cannot pick from no values");
    return value;
  };
  return { next, pick };
}

async function insertRows<T extends PgTable>(
  db: Database,
  table: T,
  kind: SeededEntity,
  rows: readonly EntityPayloadValues<T>[],
) {
  for (let start = 0; start < rows.length; start += 1000) {
    await insertEntityFixtures(
      db,
      table,
      kind,
      rows.slice(start, start + 1000),
    );
  }
}

type Random = ReturnType<typeof random>;

const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing seeded row ${index}`);
  return value;
};

async function seedTaxonomy(db: Database, { next, pick }: Random) {
  const spend = Array.from({ length: 60 }, (_, index) => ({
    ...identity("spendingCategory", index),
    name: `Synthetic spend ${index}`,
  }));
  await insertRows(db, spendingCategory, "spendingCategory", spend);
  const food = await unwrapDb(db).query.productCategory.findFirst({
    where: (category, { eq }) => eq(category.feature, "food"),
  });
  const categories: (ReturnType<typeof identity<"productCategory">> & {
    name: string;
    parentId: ProductCategoryId | null;
    spendingCategoryMode: NonNullable<
      (typeof productCategory.$inferInsert)["spendingCategoryMode"]
    >;
    spendingCategoryId: SpendingCategoryId | null;
  })[] = [];
  const addCategory = (parentId: ProductCategoryId | null, name: string) => {
    const roll = next();
    const mode = roll < 0.3 ? "mapped" : roll < 0.35 ? "blocked" : "inherit";
    const row = {
      ...identity("productCategory", categories.length),
      name,
      parentId,
      spendingCategoryMode: mode,
      spendingCategoryId: mode === "mapped" ? pick(spend).id : null,
    } satisfies typeof productCategory.$inferInsert;
    categories.push(row);
    return row;
  };
  const leaves: ProductCategoryId[] = [];
  // Root 0 hangs under the Food feature root; Product reassignment stays
  // outside it.
  const nonFoodLeaves: ProductCategoryId[] = [];
  const groups: ProductCategoryId[] = [];
  for (let root = 0; root < 4; root++) {
    const top = addCategory(
      root === 0 ? (food?.id ?? null) : null,
      `Synthetic root ${root}`,
    );
    for (let child = 0; child < 4; child++) {
      const group = addCategory(top.id, `Synthetic group ${child}`);
      leaves.push(group.id);
      if (root > 0) groups.push(group.id);
      for (let grand = 0; grand < 4; grand++) {
        const family = addCategory(group.id, `Synthetic family ${grand}`);
        leaves.push(family.id);
        if (root > 0) nonFoodLeaves.push(family.id);
        // One deeper branch reaches the resolver's ancestry limit.
        if (root === 1)
          for (let kind = 0; kind < 2; kind++)
            leaves.push(addCategory(family.id, `Synthetic kind ${kind}`).id);
      }
    }
  }
  await insertRows(db, productCategory, "productCategory", categories);
  return { spend, categories, leaves, nonFoodLeaves, groups };
}

type Line = {
  purchaseId: PurchaseId | null;
  productId: ProductId | null;
  cost: number | null;
  lineKind: (typeof expenseTable.$inferInsert)["lineKind"];
  spendingCategoryId: SpendingCategoryId | null;
  projectId: ProjectId | null;
};

/**
 * Allocation cases share Vendor 0 so its review
 * reaches them: refund-only baskets, negative adjustments beside mixed-sign
 * principals, explicit multi-Project splits, and adjustment-only Purchases
 * falling back to their default Project. Overrides use merged category 3.
 */
async function seedEdgeBaskets(
  db: Database,
  { pick }: Random,
  {
    spend,
    products,
    vendors,
    firstPurchase,
    expense,
  }: {
    spend: readonly { id: SpendingCategoryId }[];
    products: readonly { id: ProductId }[];
    vendors: readonly { id: VendorId }[];
    firstPurchase: number;
    expense: (line: Partial<Line>) => void;
  },
) {
  const projects = Array.from({ length: 4 }, (_, index) => ({
    ...identity("project", index),
    name: `Synthetic project ${index}`,
  }));
  await insertRows(db, projectTable, "project", projects);
  const project = (index: number) => at(projects, index % projects.length).id;
  const merged = at(spend, 3).id;
  const basketKinds = [
    "refund",
    "split",
    "negative",
    "adjustmentOnly",
  ] as const;
  const baskets = Array.from(
    { length: basketKinds.length },
    (_, index) =>
      ({
        ...identity("purchase", firstPurchase + index),
        kind: at(basketKinds, index),
        vendorId: at(vendors, 0).id,
        date: "2026-01-01",
        spendingCategoryId:
          at(basketKinds, index) === "adjustmentOnly"
            ? merged
            : index % 3 === 0
              ? pick(spend).id
              : null,
        spendingCategoryOrigin: index % 3 === 0 ? "manual" : "legacy",
        defaultProjectId: project(index),
      }) satisfies typeof purchase.$inferInsert & {
        kind: (typeof basketKinds)[number];
      },
  );
  await insertRows(
    db,
    purchase,
    "purchase",
    baskets.map(({ kind: _kind, ...row }) => row),
  );
  baskets.forEach(({ id: purchaseId, kind }, index) => {
    const principal = (cost: number, line: Partial<Line> = {}) =>
      expense({ purchaseId, productId: pick(products).id, cost, ...line });
    const adjustment = (lineKind: Line["lineKind"], cost: number) =>
      expense({
        purchaseId,
        lineKind,
        cost,
      });
    if (kind === "refund") {
      principal(-12.34, { spendingCategoryId: merged });
      principal(-5.01);
      adjustment("tax", -1.43);
      adjustment("shipping", 3.99);
    } else if (kind === "split") {
      principal(20.01, { projectId: project(index) });
      principal(7.33, {
        projectId: project(index + 1),
        spendingCategoryId: merged,
      });
      principal(3.5, { projectId: project(index + 2) });
      adjustment("tax", 2.47);
      adjustment("discount", -4.01);
    } else if (kind === "negative") {
      principal(15.55);
      principal(-6.2, { projectId: project(index) });
      adjustment("discount", -2.05);
      adjustment("other_adjustment", -0.99);
      adjustment("fee", 1.25);
    } else {
      adjustment("tax", 0.87);
      adjustment("discount", -3.1);
    }
  });
}

/** Small graphs retain resolution and allocation branches without load generation. */
async function seedReviewGraph(db: Database) {
  const generator = random(20261006);
  const taxonomy = await seedTaxonomy(db, generator);
  const { spend, leaves, nonFoodLeaves } = taxonomy;
  const fixtureBrandId = await findOrCreateVendor(db, "Synthetic");
  const products = Array.from({ length: 20 }, (_, index) => ({
    ...identity("product", index),
    name: `Synthetic product ${index}`,
    brandId: fixtureBrandId,
    categoryId: index < 4 ? at(leaves, index) : at(nonFoodLeaves, index - 4),
  }));
  await insertRows(db, productTable, "product", products);
  const profiles = ["unspecified", "mixed_retail", "food_retail"] as const;
  const vendors = profiles.map((spendingProfile, index) => ({
    ...identity("vendor", index),
    name: `Synthetic vendor ${index}`,
    spendingProfile,
    defaultSpendingCategoryId: index === 1 ? at(spend, 8).id : null,
  }));
  await insertRows(db, vendor, "vendor", vendors);
  const purchases = Array.from(
    { length: 4 },
    (_, index) =>
      ({
        ...identity("purchase", index),
        vendorId: at(vendors, index % vendors.length).id,
        date: "2026-01-01",
        spendingCategoryId: index === 0 ? at(spend, 2).id : null,
        spendingCategoryOrigin: index === 0 ? "manual" : "legacy",
      }) satisfies typeof purchase.$inferInsert,
  );
  await insertRows(db, purchase, "purchase", purchases);
  const mergedCategory = at(spend, 3).id;
  const inheritedVendor = {
    ...identity("vendor", vendors.length),
    name: "Synthetic merge default vendor",
    spendingProfile: "food_retail",
    defaultSpendingCategoryId: mergedCategory,
  } satisfies typeof vendor.$inferInsert;
  await insertRows(db, vendor, "vendor", [inheritedVendor]);
  const mappedCategory = {
    ...identity("productCategory", taxonomy.categories.length),
    name: "Synthetic merge mapped category",
    parentId: null,
    spendingCategoryMode: "mapped",
    spendingCategoryId: mergedCategory,
  } satisfies typeof productCategory.$inferInsert;
  await insertRows(db, productCategory, "productCategory", [mappedCategory]);
  const mappedProduct = {
    ...identity("product", products.length),
    name: "Synthetic merge mapped product",
    brandId: fixtureBrandId,
    categoryId: mappedCategory.id,
  };
  await insertRows(db, productTable, "product", [mappedProduct]);
  // Separate Purchases prevent another matching Expense override from
  // masking a missing Vendor, Purchase or mapped-category scope predicate.
  const mergePaths = Array.from(
    { length: 3 },
    (_, index) =>
      ({
        ...identity("purchase", purchases.length + index),
        vendorId: index === 0 ? inheritedVendor.id : at(vendors, 0).id,
        date: "2026-01-01",
        spendingCategoryId: index === 1 ? mergedCategory : null,
        spendingCategoryOrigin: index === 1 ? "manual" : "legacy",
      }) satisfies typeof purchase.$inferInsert,
  );
  await insertRows(db, purchase, "purchase", mergePaths);
  const expenses: (ReturnType<typeof identity<"expense">> &
    Line &
    Pick<
      typeof expenseTable.$inferInsert,
      "name" | "date" | "costType" | "trade"
    >)[] = [];
  const expense = (line: Partial<Line>) => {
    const row = {
      ...identity("expense", expenses.length),
      name: `Synthetic line ${expenses.length}`,
      date: "2026-01-01",
      costType: "materials",
      trade: "other",
      purchaseId: null,
      productId: null,
      cost: null,
      lineKind: "principal",
      spendingCategoryId: null,
      projectId: null,
      ...line,
    } satisfies (typeof expenses)[number];
    expenses.push(row);
    return row;
  };
  products.forEach((product, index) =>
    expense({
      purchaseId: at(purchases, index % purchases.length).id,
      productId: product.id,
      cost: index === 0 ? null : (100 + index) / 100,
      spendingCategoryId: index % 4 === 0 ? at(spend, 3).id : null,
    }),
  );
  expense({ cost: 10.01, spendingCategoryId: at(spend, 4).id });
  expense({ cost: 3.03 });
  const mergeExpenses = mergePaths.map((purchase, index) =>
    expense({
      purchaseId: purchase.id,
      productId: index === 2 ? mappedProduct.id : null,
      cost: (index + 1) * 10.01,
    }),
  );
  await seedEdgeBaskets(db, generator, {
    spend,
    products,
    vendors,
    firstPurchase: purchases.length + mergePaths.length,
    expense,
  });
  await insertRows(db, expenseTable, "expense", expenses);
  return { ...taxonomy, products, vendors, expenses, mergeExpenses };
}

// The pre-scoping preview: resolve and allocate every live Expense before and
// after the draft. The scoped preview must report the same counts and money.
async function referencePreview(
  db: Database,
  draft: ExpenseSpendingCategoryResolutionDraft,
  before: ExpenseJointAllocationRow[],
) {
  const facts = (
    await unwrapDb(db).execute<{
      id: string;
      before: string | null;
      after: string | null;
    }>(sql`
      SELECT e.id, ${expenseSpendingCategoryResolutionSql("e")}->>'categoryId' AS before,
        ${expenseSpendingCategoryResolutionSql("e", draft)}->>'categoryId' AS after
      FROM "Expense" e WHERE e."deletedAt" IS NULL`)
  ).rows;
  const after = await loadExpenseJointAllocations(db, undefined, draft);
  const byExpense = (rows: ExpenseJointAllocationRow[]) => {
    const values = new Map<string, string[]>();
    for (const row of rows)
      values.set(row.expenseId, [
        ...(values.get(row.expenseId) ?? []),
        JSON.stringify([
          row.principalExpenseId,
          row.projectId,
          row.spendingCategoryId,
          row.attributedCents?.toString() ?? null,
          row.categoryIncomplete,
        ]),
      ]);
    return new Map(
      [...values].map(([id, list]) => [id, JSON.stringify(list.sort())]),
    );
  };
  const changed = new Set(
    facts.filter((row) => row.before !== row.after).map((row) => row.id),
  );
  const beforeByExpense = byExpense(before);
  const afterByExpense = byExpense(after);
  for (const id of new Set([
    ...beforeByExpense.keys(),
    ...afterByExpense.keys(),
  ]))
    if (beforeByExpense.get(id) !== afterByExpense.get(id)) changed.add(id);
  const totals = (rows: ExpenseJointAllocationRow[]) => {
    const result = new Map<
      string | null,
      { name: string | null; cents: bigint }
    >();
    for (const row of rows)
      result.set(row.spendingCategoryShortcode, {
        name: row.spendingCategoryName,
        cents:
          (result.get(row.spendingCategoryShortcode)?.cents ?? 0n) +
          (row.attributedCents ?? 0n),
      });
    return result;
  };
  const beforeTotals = totals(before);
  const afterTotals = totals(after);
  const expensesWhere = (
    rows: ExpenseJointAllocationRow[],
    predicate: (row: ExpenseJointAllocationRow) => boolean,
  ) => new Set(rows.filter(predicate).map((row) => row.expenseId)).size;
  const uncategorized = (row: ExpenseJointAllocationRow) =>
    row.spendingCategoryId === null || row.categoryIncomplete;
  return {
    expenseCount: facts.length,
    changedExpenseCount: changed.size,
    unpricedExpenseCount: expensesWhere(
      after,
      (row) => row.sourceCents === null,
    ),
    beforeUncategorizedExpenseCount: expensesWhere(before, uncategorized),
    afterUncategorizedExpenseCount: expensesWhere(after, uncategorized),
    categoryDeltas: [
      ...new Set([...beforeTotals.keys(), ...afterTotals.keys()]),
    ]
      .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
      .map((code) => {
        const beforeCents = beforeTotals.get(code)?.cents ?? 0n;
        const afterCents = afterTotals.get(code)?.cents ?? 0n;
        return {
          spendingCategoryId: code,
          spendingCategoryName:
            afterTotals.get(code)?.name ?? beforeTotals.get(code)?.name ?? null,
          beforeCents: beforeCents.toString(),
          afterCents: afterCents.toString(),
          deltaCents: (afterCents - beforeCents).toString(),
        };
      }),
  };
}

describe("spending classification preview equivalence", () => {
  const ctx = withTestDb();

  // Each request reaches Expenses differently: a heavy Vendor, merges through
  // overrides, Purchase and Vendor defaults, and mappings, a mapped subtree,
  // reassigned Products, and set or cleared Expense overrides (adjustment
  // lines included).
  it("previews the same counts and money as resolving every Expense", async () => {
    const seeded = await seedReviewGraph(ctx.db);
    // The money cases the equivalence must hold over are really present.
    const allocations = await loadExpenseJointAllocations(ctx.db);
    for (const subject of seeded.mergeExpenses)
      expect(
        allocations.find((row) => row.expenseId === subject.id)
          ?.spendingCategoryId,
      ).toBe(at(seeded.spend, 3).id);
    const adjustments = allocations.filter((row) => row.basis !== "principal");
    const projectsByPurchase = new Map<string | null, Set<string>>();
    for (const row of allocations)
      if (row.basis === "principal" && row.projectId)
        projectsByPurchase.set(
          row.purchaseId,
          (projectsByPurchase.get(row.purchaseId) ?? new Set()).add(
            row.projectId,
          ),
        );
    expect({
      bases: [...new Set(adjustments.map((row) => row.basis))].sort(),
      negativeAdjustments: adjustments.some(
        (row) => (row.sourceCents ?? 0n) < 0n,
      ),
      multiProjectPurchases: [...projectsByPurchase.values()].some(
        (projects) => projects.size > 1,
      ),
    }).toEqual({
      bases: ["default", "positive", "refund"],
      negativeAdjustments: true,
      multiProjectPurchases: true,
    });
    const spend = (index: number) => at(seeded.spend, index);
    const vendor = at(seeded.vendors, 0);
    const group = seeded.categories.find(
      (row) => row.id === at(seeded.groups, 3),
    );
    const target = seeded.categories.find(
      (row) => row.id === at(seeded.nonFoodLeaves, 7),
    );
    if (!group || !target) throw new Error("Missing seeded categories");
    const moved = seeded.products
      .filter(
        (row) =>
          row.categoryId && seeded.nonFoodLeaves.includes(row.categoryId),
      )
      .slice(0, 5);
    const reviewed = seeded.expenses.filter((_, index) => index % 97 === 7);
    const overridden = seeded.expenses
      .filter((row) => row.spendingCategoryId)
      .filter((_, index) => index % 5 === 0);
    const merged = (keep: number, from: number[]) => ({
      request: {
        action: "spendingCategoryMerge" as const,
        keepId: spend(keep).shortcode,
        mergeIds: from.map((index) => spend(index).shortcode),
      },
      draft: {
        categoryRedirects: from.map((index) => ({
          id: spend(index).id,
          keepId: spend(keep).id,
        })),
      },
    });
    const assigned = (
      rows: typeof seeded.expenses,
      category: (typeof seeded.spend)[number] | null,
    ) => ({
      request: {
        action: "expenses" as const,
        expenseIds: rows.map((row) => row.shortcode),
        spendingCategoryId: category?.shortcode ?? null,
      },
      draft: {
        expenses: rows.map((row) => ({
          id: row.id,
          spendingCategoryId: category?.id ?? null,
        })),
      },
    });
    const cases = {
      vendor: {
        request: {
          action: "vendor" as const,
          vendorId: vendor.shortcode,
          spendingProfile: "food_retail" as const,
          defaultSpendingCategoryId: spend(1).shortcode,
        },
        draft: {
          vendors: [
            {
              id: vendor.id,
              spendingProfile: "food_retail" as const,
              defaultSpendingCategoryId: spend(1).id,
            },
          ],
        },
      },
      merge: merged(2, [3, 4]),
      productCategory: {
        request: {
          action: "productCategory" as const,
          productCategoryId: group.shortcode,
          spendingCategoryMode: "mapped" as const,
          spendingCategoryId: spend(5).shortcode,
        },
        draft: {
          productCategories: [
            {
              id: group.id,
              spendingCategoryMode: "mapped" as const,
              spendingCategoryId: spend(5).id,
            },
          ],
        },
      },
      products: {
        request: {
          action: "products" as const,
          productIds: moved.map((row) => row.shortcode),
          productCategoryId: target.shortcode,
        },
        draft: {
          products: moved.map((row) => ({
            id: row.id,
            categoryId: target.id,
          })),
        },
      },
      expenses: assigned(reviewed, spend(6)),
      "cleared overrides": assigned(overridden, null),
    };
    for (const [name, { request, draft }] of Object.entries(cases)) {
      const {
        request: _request,
        policyRevision: _revision,
        fingerprint: _fingerprint,
        ...impact
      } = await previewSpendingClassificationReview(ctx.db, request);
      expect(impact.changedExpenseCount).toBeGreaterThan(0);
      expect({ name, impact }).toEqual({
        name,
        // Every preview is read-only; the original allocation baseline is
        // shared, while each draft's expected result is resolved afresh.
        impact: await referencePreview(ctx.db, draft, allocations),
      });
    }
  });
});
