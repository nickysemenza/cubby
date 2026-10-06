import { randomUUID } from "node:crypto";

import {
  parseEntityId,
  parseShortcodeFor,
  type ProductCategoryId,
  type PurchaseId,
  type SpendingCategoryId,
} from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";

import { unwrapDb } from "./database-helpers";
import {
  expenseSpendingCategoryResolutionSql,
  type ExpenseSpendingCategoryResolutionDraft,
} from "./expense-category-resolution";
import {
  loadExpenseJointAllocations,
  type ExpenseJointAllocationRow,
} from "./expense-project-allocation";
import { previewSpendingClassificationReview } from "./spending-classification-review";

type SeededEntity =
  | "spendingCategory"
  | "productCategory"
  | "product"
  | "vendor"
  | "purchase"
  | "expense";
const PREFIX = {
  spendingCategory: "SPC-",
  productCategory: "CAT-",
  product: "PRD-",
  vendor: "VEN-",
  purchase: "PUR-",
  expense: "EXP-",
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
  const cents = (max: number) => Math.round(next() * max) / 100;
  return { next, pick, cents };
}

// Every row of a table lists the same columns; an absent one would insert
// NULL over its default.
async function insertRows(db: Database, table: string, rows: object[]) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  for (let start = 0; start < rows.length; start += 1000) {
    const chunk = JSON.stringify(rows.slice(start, start + 1000));
    await unwrapDb(db).execute(
      sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
        keys.map((key) => sql.identifier(key)),
        sql`, `,
      )}) SELECT ${sql.join(
        keys.map((key) => sql`r.${sql.identifier(key)}`),
        sql`, `,
      )} FROM json_populate_recordset(NULL::${sql.identifier(table)}, ${chunk}::json) r`,
    );
  }
}

type Random = ReturnType<typeof random>;

async function seedTaxonomy(db: Database, { next, pick }: Random) {
  const spend = Array.from({ length: 60 }, (_, index) => ({
    ...identity("spendingCategory", index),
    name: `Synthetic spend ${index}`,
  }));
  await insertRows(db, "SpendingCategory", spend);
  const food = await unwrapDb(db).query.productCategory.findFirst({
    where: (category, { eq }) => eq(category.feature, "food"),
  });
  const categories: (ReturnType<typeof identity<"productCategory">> & {
    name: string;
    parentId: ProductCategoryId | null;
    spendingCategoryMode: string;
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
    };
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
  await insertRows(db, "ProductCategory", categories);
  return { spend, categories, leaves, nonFoodLeaves, groups };
}

/** Scale 1 matches the measured household: ~12.5k Expenses over ~3.6k Purchases. */
async function seedSyntheticHousehold(db: Database, scale: number) {
  const generator = random(20261006);
  const { next, pick, cents } = generator;
  const count = (full: number) => Math.round(full * scale);
  const taxonomy = await seedTaxonomy(db, generator);
  const { spend, leaves } = taxonomy;
  const products = Array.from({ length: count(6200) }, (_, index) => ({
    ...identity("product", index),
    name: `Synthetic product ${index}`,
    manufacturer: "Synthetic",
    categoryId: next() < 0.9 ? pick(leaves) : null,
  }));
  await insertRows(db, "Product", products);
  const profiles = [
    "unspecified",
    "mixed_retail",
    "food_retail",
    "restaurant",
    "coffee_shop",
  ] as const;
  const vendors = Array.from({ length: 150 }, (_, index) => ({
    ...identity("vendor", index),
    name: `Synthetic vendor ${index}`,
    spendingProfile: pick(profiles),
    defaultSpendingCategoryId: next() < 0.5 ? pick(spend).id : null,
  }));
  await insertRows(db, "Vendor", vendors);
  const purchases = Array.from({ length: count(3600) }, (_, index) => {
    const categorized = next() < 0.2;
    return {
      ...identity("purchase", index),
      // Vendor 0 is a heavy merchant, as in a real household.
      vendorId: index % 4 === 0 ? vendors[0]?.id : pick(vendors).id,
      date: "2026-01-01",
      spendingCategoryId: categorized ? pick(spend).id : null,
      spendingCategoryOrigin: categorized
        ? pick(["legacy", "manual", "source"])
        : "legacy",
    };
  });
  await insertRows(db, "Purchase", purchases);
  type Line = {
    purchaseId: PurchaseId | null;
    productId: string | null;
    cost: number | null;
    lineKind: string;
    spendingCategoryId: SpendingCategoryId | null;
  };
  const expenses: (ReturnType<typeof identity<"expense">> &
    Line & { name: string; date: string; costType: string; trade: string })[] =
    [];
  const expense = (line: Partial<Line>) =>
    expenses.push({
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
      ...line,
    });
  for (const purchase of purchases)
    expense({
      purchaseId: purchase.id,
      productId: next() < 0.8 ? pick(products).id : null,
      cost: cents(10000),
    });
  while (expenses.length < count(11300)) {
    const roll = next();
    expense({
      purchaseId: pick(purchases).id,
      productId: next() < 0.8 ? pick(products).id : null,
      cost: roll < 0.02 ? null : cents(10000) * (roll < 0.06 ? -1 : 1),
      spendingCategoryId: next() < 0.05 ? pick(spend).id : null,
    });
  }
  while (expenses.length < count(12000))
    expense({
      purchaseId: pick(purchases).id,
      lineKind: pick(["tax", "shipping", "discount"]),
      cost: cents(1000),
      spendingCategoryId: next() < 0.2 ? pick(spend).id : null,
    });
  while (expenses.length < count(12500))
    expense({
      cost: cents(10000),
      spendingCategoryId: next() < 0.3 ? pick(spend).id : null,
    });
  await insertRows(db, "Expense", expenses);
  // Production tables carry planner statistics; bulk-inserted ones do not yet.
  await unwrapDb(db).execute(sql`ANALYZE`);
  return { ...taxonomy, products, vendors, expenses };
}

// The pre-scoping preview: resolve and allocate every live Expense before and
// after the draft. The scoped preview must report the same counts and money.
async function referencePreview(
  db: Database,
  draft: ExpenseSpendingCategoryResolutionDraft,
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
  const before = await loadExpenseJointAllocations(db);
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

const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing seeded row ${index}`);
  return value;
};

describe("spending classification preview at household scale", () => {
  const ctx = withTestDb();

  // Each request reaches Expenses differently: a heavy Vendor, merges through
  // overrides, Purchase and Vendor defaults, and mappings, a mapped subtree,
  // reassigned Products, and set or cleared Expense overrides (adjustment
  // lines included). Scale 1 reproduces the production-sized measurement.
  it(
    "previews the same counts and money as resolving every Expense",
    { timeout: 300_000 },
    async () => {
      const seeded = await seedSyntheticHousehold(ctx.db, 0.2);
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
        "merge reaching most Expenses": merged(
          10,
          Array.from({ length: 45 }, (_, index) => index + 11),
        ),
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
          impact: await referencePreview(ctx.db, draft),
        });
      }
    },
  );
});
