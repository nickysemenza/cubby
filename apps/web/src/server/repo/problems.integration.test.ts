import type {
  FinancialAccountId,
  ProductShortcode,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { mealCreateInput } from "@cubby/schemas/meal";
import { buildNutrition } from "@cubby/schemas/nutrition";
import {
  type ExpenseCreateInput,
  expenseCreateInput,
} from "@cubby/schemas/project";
import { eq, sql } from "drizzle-orm";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  financialTransaction,
  ingredient,
  product,
  productComponent,
  recipe,
} from "~/server/db/schema";

import {
  taxonomyId,
  taxonomyShortcode,
} from "../../../tooling/product-category-fixtures";
import { requireActor } from "../request-context";
import { runDiagnostic } from "../services/problem-diagnostics.service";
import { findViewProblems } from "../services/problem-views.service";
import { findFastProblems } from "../services/problems.service";
import { createTestRequestContext } from "../testing/request-context";
import {
  pruneAllUnusedAliasesWorkflow,
  reparseStaleWorkflow,
} from "../workflows/problems.server";
import { setDataException } from "./data-quality";
import { getDb } from "./database-helpers";
import { createExpense, updateExpense } from "./expense";
import { updateFinancialTransaction } from "./financial-transaction";
import { createMealWithEntityId } from "./meal/crud";
import { findEntitiesMissingEmbeddings } from "./problems";
import { getPurchaseByID, purchaseList, updatePurchase } from "./purchase";
import {
  createIngredientFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createRecipeFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";

/**
 * The ledger repos hand back `{ output, entityId }` — the uuid is for audit and
 * side-effect bookkeeping. These tests assert on the public shape.
 */
const unwrap = async <T>(p: Promise<{ output: T }>): Promise<T> =>
  (await p).output;

const page = { pageIndex: 0, pageSize: 100 };

// The defect/coverage split. `totalProblems` — the navbar badge, the homepage
// banner, the headline card — must count only rows that can reach zero;
// coverage rows (un-itemized bins, un-photographed tools, un-recounted shelves)
// never can, and folding them in is what made the badge permanently red.

describe("problems — unlinked exit expenses", () => {
  const ctx = withTestDb();

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  it("reports only itemized principal lines from disposal purchases", async () => {
    const sharedPurchase = {
      vendor: "Example resale marketplace",
      orderId: "EXAMPLE-SALE-1",
    };
    const soldItem = await seedLine({
      ...sharedPurchase,
      name: "Sold item without identified product",
      cost: -100,
      lineKind: "principal",
      lineBasis: "item_line",
    });
    const taxCredit = await seedLine({
      ...sharedPurchase,
      name: "Tax refund",
      cost: -8,
      lineKind: "tax",
      lineBasis: "item_line",
    });
    const allocatedCredit = await seedLine({
      ...sharedPurchase,
      name: "Allocated marketplace credit",
      cost: -12,
      lineKind: "principal",
      lineBasis: "allocation",
    });

    expect(taxCredit.purchaseId).toBe(soldItem.purchaseId);
    expect(allocatedCredit.purchaseId).toBe(soldItem.purchaseId);

    const ids = (await findFastProblems(ctx.db)).unlinkedExitExpenses.map(
      (row) => row.id,
    );

    expect(ids).toContain(soldItem.id);
    expect(ids).not.toContain(taxCredit.id);
    expect(ids).not.toContain(allocatedCredit.id);
  });
});

describe("problems — view-backed uniform rows", () => {
  const ctx = withTestDb();

  // The presenters parse list rows by field name, so a renamed list field
  // fails only once a real row reaches the section.
  it("presents list rows as entity rows with evidence and record badges", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Test shelf", type: "shelf" }),
      ctx.actor,
    );
    const thing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unpriced test good" }),
      ctx.actor,
    );
    const entry = await createInventoryFixture(
      ctx.db,
      {
        productId: thing.id,
        locationId: shelf.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const unused = await createIngredientFixture(
      ctx.db,
      { name: "Unused test ingredient" },
      ctx.actor,
    );

    const views = await findViewProblems(ctx.db);
    const shelfBadge = {
      label: "Test shelf",
      entity: "location",
      id: shelf.id,
    };

    expect(
      views.neverVerifiedInventory.find((row) => row.id === entry.id),
    ).toEqual({
      entity: "inventory",
      id: entry.id,
      name: "Unpriced test good",
      subtitle: "2 each",
      badges: [shelfBadge],
    });
    expect(
      views.productsMissingPrice.find((row) => row.id === thing.id),
    ).toMatchObject({
      entity: "product",
      subtitle: "by Test Manufacturer · 2 units unvalued",
      badges: [shelfBadge],
    });
    expect(views.staleLocations.find((row) => row.id === shelf.id)).toEqual({
      entity: "location",
      id: shelf.id,
      name: "Test shelf",
      subtitle: "never recounted",
      badges: [
        { label: "shelf", entity: null, id: null },
        { label: "1 item", entity: null, id: null },
      ],
    });
    expect(
      views.unusedIngredientsWithoutProduct.find((row) => row.id === unused.id),
    ).toMatchObject({
      entity: "ingredient",
      subtitle: "Used in no recipes · no product attached",
    });
  });
});

describe("problems — orphaned products", () => {
  const ctx = withTestDb();

  it("does not report either side of a live product composition", async () => {
    const [kit, component, orphan] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Example composed kit" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Example kit component" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Example orphan candidate" }),
        ctx.actor,
      ),
    ]);
    await getDb(ctx.db).insert(productComponent).values({
      parentProductId: kit.entityId,
      componentProductId: component.entityId,
      quantity: 1,
    });

    const ids = (await findFastProblems(ctx.db)).orphanedProducts.map(
      (row) => row.id,
    );

    expect(ids).not.toContain(kit.id);
    expect(ids).not.toContain(component.id);
    expect(ids).toContain(orphan.id);
  });
});

describe("problems — missing embeddings", () => {
  const ctx = withTestDb();

  it("excludes recipe-backed ingredient proxies that cannot be embedded", async () => {
    const realIngredient = await createIngredientFixture(
      ctx.db,
      { name: "Example real ingredient", aliases: [] },
      ctx.actor,
    );
    const recipeRow = await insertWithShortcode(ctx.db, "recipe", {
      name: "Example proxy recipe",
    });
    const proxy = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Recipe: Example proxy recipe",
      aliases: [],
      recipeId: recipeRow.id,
    });

    const missing = await findEntitiesMissingEmbeddings(
      ctx.db,
      {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      { limit: 1_000 },
    );
    const ingredientIds = missing
      .filter((row) => row.entityType === "ingredient")
      .map((row) => row.entityId);

    expect(ingredientIds).toContain(realIngredient.id);
    expect(ingredientIds).not.toContain(
      parseShortcodeFor("ingredient", proxy.shortcode),
    );
  });

  // Expense is searchable (lexical search must still find it) but not
  // embeddable (`entity-manifest.ts` `embeddableEntities` — see
  // `16-expense.entity.ts` `search: { enabled: true, embedding: false }`),
  // so it must never appear here even though it has no `EntityEmbedding` row
  // at all. The other two financial entities (purchase,
  // financialTransaction) share the same declaration shape and the same
  // `embeddingSources` roster in `detectors-embedding.ts`, so this exercises
  // the shared mechanism rather than a per-entity special case.
  it("never reports a financial (searchable-but-not-embeddable) entity as missing", async () => {
    const { output: expense } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "Example financial-only expense" }),
      ),
      ctx.actor,
    );

    const missing = await findEntitiesMissingEmbeddings(
      ctx.db,
      {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      { limit: 1_000 },
    );

    expect(missing.some((row) => row.entityType === "expense")).toBe(false);
    expect(missing.some((row) => row.entityId === expense.id)).toBe(false);
  });
});

describe("problems — understated meal cost", () => {
  const ctx = withTestDb();

  it("reports only the affected recipes with their exact persisted coverage", async () => {
    const [incomplete, complete] = await Promise.all([
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Underpriced test recipe" }),
        ctx.actor,
      ),
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Fully priced test recipe" }),
        ctx.actor,
      ),
    ]);
    await Promise.all([
      getDb(ctx.db)
        .update(recipe)
        .set({
          totals: {
            cost: {
              status: "partial",
              lower: 4,
              upper: null,
              coverage: { covered: 2, total: 3 },
            },
            nutrition: buildNutrition(() => ({
              status: "unavailable",
              reason: "no_data",
            })),
          },
          totalsComputedAt: new Date(),
        })
        .where(eq(recipe.id, incomplete.entityId)),
      getDb(ctx.db)
        .update(recipe)
        .set({
          totals: {
            cost: {
              status: "complete",
              lower: 6,
              upper: null,
              coverage: { covered: 2, total: 2 },
            },
            nutrition: buildNutrition(() => ({
              status: "unavailable",
              reason: "no_data",
            })),
          },
          totalsComputedAt: new Date(),
        })
        .where(eq(recipe.id, complete.entityId)),
    ]);
    const meal = (
      await createMealWithEntityId(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-01",
          name: "Coverage dinner",
          recipes: [{ recipeId: incomplete.id }, { recipeId: complete.id }],
        }),
        ctx.actor,
      )
    ).output;

    const row = (await findFastProblems(ctx.db)).understatedCostMeals.find(
      (candidate) => candidate.id === meal.id,
    );

    expect(row).toMatchObject({
      id: meal.id,
      recipeCount: 1,
      affectedRecipes: [
        {
          id: incomplete.id,
          name: "Underpriced test recipe",
          costCovered: 2,
          ingredientCount: 3,
        },
      ],
    });
  });

  it("reports 0-of-N unavailable costs but not legacy or empty ones", async () => {
    const unavailableNutrition = buildNutrition(() => ({
      status: "unavailable",
      reason: "no_data",
    }));
    const [zeroPriced, legacy, empty] = await Promise.all([
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Zero priced test recipe" }),
        ctx.actor,
      ),
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Legacy unavailable test recipe" }),
        ctx.actor,
      ),
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Empty test recipe" }),
        ctx.actor,
      ),
    ]);
    await Promise.all([
      getDb(ctx.db)
        .update(recipe)
        .set({
          totals: {
            cost: {
              status: "unavailable",
              reason: "no_data",
              coverage: { covered: 0, total: 2 },
            },
            nutrition: unavailableNutrition,
          },
          totalsComputedAt: new Date(),
        })
        .where(eq(recipe.id, zeroPriced.entityId)),
      // Persisted before `coverage` existed: excluded until recomputed.
      getDb(ctx.db)
        .update(recipe)
        .set({
          totals: {
            cost: { status: "unavailable", reason: "no_data" },
            nutrition: unavailableNutrition,
          },
          totalsComputedAt: new Date(),
        })
        .where(eq(recipe.id, legacy.entityId)),
      getDb(ctx.db)
        .update(recipe)
        .set({
          totals: {
            cost: { status: "unavailable", reason: "empty" },
            nutrition: unavailableNutrition,
          },
          totalsComputedAt: new Date(),
        })
        .where(eq(recipe.id, empty.entityId)),
    ]);
    const meal = (
      await createMealWithEntityId(
        ctx.db,
        mealCreateInput.parse({
          date: "2026-09-02",
          name: "Unpriced dinner",
          recipes: [
            { recipeId: zeroPriced.id },
            { recipeId: legacy.id },
            { recipeId: empty.id },
          ],
        }),
        ctx.actor,
      )
    ).output;

    const row = (await findFastProblems(ctx.db)).understatedCostMeals.find(
      (candidate) => candidate.id === meal.id,
    );

    expect(row).toMatchObject({
      id: meal.id,
      recipeCount: 1,
      affectedRecipes: [
        {
          id: zeroPriced.id,
          name: "Zero priced test recipe",
          costCovered: 0,
          ingredientCount: 2,
        },
      ],
    });
  });
});

describe("problems — charges not reconciling", () => {
  const ctx = withTestDb();

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const setStated = (id: PurchaseShortcode, statedTotal: number) =>
    unwrap(updatePurchase(ctx.db, id, { statedTotal }, ctx.actor));

  it("flags charges whose lines don't add up, biggest gap first, and leaves a matching one alone", async () => {
    const big = await seedLine({
      name: "big gap line",
      cost: 300,
      vendor: "Reconcile Depot",
      orderId: "RD-BIG",
    });
    const small = await seedLine({
      name: "small gap line",
      cost: 85,
      vendor: "Reconcile Depot",
      orderId: "RD-SMALL",
    });
    const okFirst = await seedLine({
      name: "matching line a",
      cost: 60,
      vendor: "Reconcile Depot",
      orderId: "RD-OK",
    });
    const okSecond = await seedLine({
      name: "matching line b",
      cost: 40,
      vendor: "Reconcile Depot",
      orderId: "RD-OK",
    });
    expect(okSecond.purchaseId).toBe(okFirst.purchaseId);

    const bigCharge = await setStated(
      parseShortcodeFor("purchase", big.purchaseId),
      500,
    );
    const smallCharge = await setStated(
      parseShortcodeFor("purchase", small.purchaseId),
      100,
    );
    const okCharge = await setStated(
      parseShortcodeFor("purchase", okFirst.purchaseId),
      100,
    );

    const { purchasesNotReconciling } = await findFastProblems(ctx.db);

    expect(purchasesNotReconciling.map((c) => c.id)).toEqual([
      bigCharge.id,
      smallCharge.id,
    ]);
    expect(purchasesNotReconciling.map((c) => c.id)).not.toContain(okCharge.id);
    expect(purchasesNotReconciling[1]).toMatchObject({
      id: smallCharge.id,
      vendorName: "Reconcile Depot",
      orderId: "RD-SMALL",
      statedTotal: 100,
      expenseTotal: 85,
      expenseCount: 1,
    });
  });

  it("excludes differences fully explained by posted refund evidence", async () => {
    const line = await seedLine({
      name: "refund-adjusted purchase",
      cost: 60,
      vendor: "Posted Refund Mart",
      orderId: "PRM-1",
    });
    const charge = await setStated(
      parseShortcodeFor("purchase", line.purchaseId),
      100,
    );
    const purchaseId = parseEntityId(
      "purchase",
      (await resolveLiveShortcode(ctx.db, charge.id, "purchase"))!,
    );
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Posted Refund Card",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
      },
      cardNumbers: [
        {
          last4: "4040",
          kind: "primary",
          validFrom: null,
          validTo: null,
          note: null,
        },
      ],
      provisional: false,
      sourceAliases: [],
      notes: null,
    });
    const refund = await insertSettlementTransaction(ctx.db, {
      accountId: account.id,
      purchaseId,
      kind: "refund",
      status: "pending",
      amount: -40,
      transactionDate: "2026-07-02",
      postedDate: null,
      merchant: "Posted Refund Mart",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
    });

    expect(
      (await findFastProblems(ctx.db)).purchasesNotReconciling,
    ).toHaveLength(1);

    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ status: "posted", postedDate: "2026-07-03" })
      .where(eq(financialTransaction.id, refund.id));

    expect((await findFastProblems(ctx.db)).purchasesNotReconciling).toEqual(
      [],
    );
  });
});

describe("problems — duplicate spend candidates", () => {
  const ctx = withTestDb();

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const candidates = async () =>
    (await findFastProblems(ctx.db)).duplicateSpendCandidates;

  it("flags an unlinked lump matching a purchase's expense total", async () => {
    await seedLine({
      name: "framing nails 2 in ring shank collated",
      cost: 30,
      date: "2024-06-02",
      vendor: "Nail Depot",
      orderId: "ND-1",
    });
    await seedLine({
      name: "wood glue",
      cost: 13.43,
      date: "2024-06-02",
      vendor: "Nail Depot",
      orderId: "ND-1",
    });
    // The hand-entered lump: same money, no purchase, terse name.
    const lump = await seedLine({
      name: "framing nails",
      cost: 43.43,
      date: "2024-06-02",
    });

    const rows = await candidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: lump.id,
      cost: 43.43,
      matchedOn: "expense_total",
      dayDelta: 0,
      purchaseExpenseTotal: 43.43,
      purchaseExpenseCount: 2,
      alternateMatchCount: 0,
    });
    expect(rows[0]?.nameSimilarity).toBeGreaterThanOrEqual(0.15);
  });

  it("ignores a same-amount, same-day collision between unrelated things", async () => {
    await seedLine({
      name: "monoprice cat6a ethernet patch cable",
      cost: 22,
      date: "2024-02-16",
      vendor: "Cable Mart",
      orderId: "CM-1",
    });
    await seedLine({ name: "fiskars pruners", cost: 22, date: "2024-02-16" });

    expect(await candidates()).toEqual([]);
  });
});

// The settlement verdict against FinancialTransaction evidence — a different
// question from "charges not reconciling" above, which compares a charge's
// stated total against its own lines and never looks at a card statement.
describe("problems — purchase financial settlement mismatches", () => {
  const ctx = withTestDb();

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const seedAccount = () =>
    insertWithShortcode(ctx.db, "financialAccount", {
      name: "Settlement Visa",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
      },
      cardNumbers: [
        {
          last4: "1111",
          kind: "primary",
          validFrom: null,
          validTo: null,
          note: null,
        },
      ],
      provisional: false,
      sourceAliases: [],
      notes: null,
    });

  const postCharge = async (
    accountId: FinancialAccountId,
    purchaseShortcode: PurchaseShortcode,
    amount: number,
  ) => {
    const purchaseId = parseEntityId(
      "purchase",
      (await resolveLiveShortcode(ctx.db, purchaseShortcode, "purchase"))!,
    );
    return await insertSettlementTransaction(ctx.db, {
      accountId,
      purchaseId,
      kind: "purchase",
      status: "posted",
      amount,
      transactionDate: "2026-07-01",
      postedDate: "2026-07-03",
      merchant: "Settlement Merchant",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
    });
  };

  const mismatches = async () =>
    (await findFastProblems(ctx.db)).purchaseFinancialSettlementMismatches;

  it("flags a purchase the card evidence underpays, and leaves a fully-settled one alone", async () => {
    const settled = await seedLine({
      name: "settled in full",
      cost: 120,
      vendor: "Settle Depot",
      orderId: "SD-MATCH",
    });
    const short = await seedLine({
      name: "short-settled",
      cost: 120,
      vendor: "Settle Depot",
      orderId: "SD-SHORT",
    });
    const account = await seedAccount();
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", settled.purchaseId),
      120,
    );
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", short.purchaseId),
      95,
    );

    const rows = await mismatches();
    expect(rows.map((row) => row.id)).toEqual([short.purchaseId]);
    expect(rows[0]).toMatchObject({
      vendorName: "Settle Depot",
      expenseTotal: 120,
      financialReconciliation: {
        status: "mismatch",
        postedTransactionCount: 1,
        outstandingTransactionCount: 0,
        postedTotal: 95,
        delta: -25,
      },
    });
  });

  it("hides only an active, reasoned settlement mismatch while retaining its financial delta", async () => {
    const mismatched = await seedLine({
      name: "documented card residual",
      cost: 120,
      vendor: "Settle Depot",
      orderId: "SD-RESIDUAL",
    });
    const account = await seedAccount();
    if (!mismatched.purchaseId) throw new Error("Fixture has no Purchase");
    const purchaseShortcode = mismatched.purchaseId;
    const transaction = await postCharge(
      account.id,
      parseShortcodeFor("purchase", purchaseShortcode),
      119.98,
    );

    expect((await mismatches()).map((row) => row.id)).toEqual([
      purchaseShortcode,
    ]);
    expect(
      (await purchaseList(ctx.db, { dataStatus: "defect" }, [], page)).data.map(
        (row) => row.id,
      ),
    ).toContain(purchaseShortcode);

    const quality = await setDataException(
      ctx.db,
      {
        entityId: purchaseShortcode,
        check: "settlement_mismatch",
        reason: "expected_mismatch",
        note: "Vendor confirmation is $120.00; posted bank evidence totals $119.98.",
      },
      ctx.actor,
    );
    expect(quality.exceptions).toContainEqual(
      expect.objectContaining({
        check: "settlement_mismatch",
        reason: "expected_mismatch",
        state: "active",
      }),
    );
    expect(await mismatches()).toEqual([]);
    expect(
      (await purchaseList(ctx.db, { dataStatus: "defect" }, [], page)).data.map(
        (row) => row.id,
      ),
    ).not.toContain(purchaseShortcode);

    const purchaseId = parseEntityId(
      "purchase",
      (await resolveLiveShortcode(ctx.db, purchaseShortcode, "purchase"))!,
    );
    const financial = (await getPurchaseByID(ctx.db, purchaseId))
      .financialReconciliation;
    expect(financial.status).toBe("mismatch");
    expect(financial.delta).toBeCloseTo(-0.02);

    // Expense writes advance the Purchase evidence clock, so the acceptance
    // cannot silently survive a changed ledger total.
    await updateExpense(ctx.db, mismatched.id, { cost: 120.01 }, ctx.actor);
    expect((await mismatches()).map((row) => row.id)).toEqual([
      purchaseShortcode,
    ]);

    await setDataException(
      ctx.db,
      {
        entityId: purchaseShortcode,
        check: "settlement_mismatch",
        reason: "expected_mismatch",
        note: "The changed settlement amount is documented separately.",
      },
      ctx.actor,
    );
    expect(await mismatches()).toEqual([]);

    // Moving a line between planned and incurred spend changes the comparison
    // total even though its money value stays fixed.
    await updateExpense(ctx.db, mismatched.id, { future: true }, ctx.actor);
    expect((await mismatches()).map((row) => row.id)).toEqual([
      purchaseShortcode,
    ]);
    expect(
      (await getPurchaseByID(ctx.db, purchaseId)).dataQuality.exceptions.find(
        (exception) => exception.check === "settlement_mismatch",
      )?.state,
    ).toBe("stale");

    await setDataException(
      ctx.db,
      {
        entityId: purchaseShortcode,
        check: "settlement_mismatch",
        reason: "expected_mismatch",
        note: "The revised expense total still differs from the posted bank evidence.",
      },
      ctx.actor,
    );
    expect(await mismatches()).toEqual([]);

    // FinancialTransaction writes use the same target touch through the
    // allocation path, including the single-allocation amount shorthand.
    await updateFinancialTransaction(
      ctx.db,
      parseShortcodeFor("financialTransaction", transaction.shortcode),
      { amount: 119.97 },
      ctx.actor,
    );
    expect((await mismatches()).map((row) => row.id)).toEqual([
      purchaseShortcode,
    ]);
  });

  it("compares against incurred spend only, so a planned line can't manufacture a mismatch", async () => {
    const deposit = await seedLine({
      name: "venue deposit",
      cost: 100,
      vendor: "Venue Co",
      orderId: "VC-1",
    });
    const planned = await seedLine({
      name: "venue remaining payments",
      cost: 400,
      future: true,
      vendor: "Venue Co",
      orderId: "VC-1",
    });
    expect(planned.purchaseId).toBe(deposit.purchaseId);

    const account = await seedAccount();
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", deposit.purchaseId),
      100,
    );

    expect(await mismatches()).toEqual([]);
  });
});

/**
 * `kitsCountedTwice` — a kit on the books under its own name AND under its
 * parts', together claiming more units than were bought.
 *
 * Asserted through `findFastProblems` rather than the list filter it compiles
 * to, because the presenter is a separate switch that THROWS on an unregistered
 * key. A detector whose filter works and whose card presenter is missing fails
 * only when the first real row appears, which is the worst possible moment.
 */

describe("problems — weight-sold products", () => {
  const ctx = withTestDb();

  /** Book `costs` as priced principal expense lines against one product. */
  const bookLines = async (productId: ProductShortcode, costs: number[]) => {
    for (const [i, cost] of costs.entries()) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: `line ${i}`,
            cost,
            productId,
            productQuantity: 1,
            lineKind: "principal",
          }),
        ),
        ctx.actor,
      );
    }
  };

  it("separates weight-sold goods from packaged ones whose price merely drifted", async () => {
    const [weighed, packaged, narrow] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Weighed test produce" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Packaged test good" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Steady test good" }),
        ctx.actor,
      ),
    ]);

    await Promise.all([
      // Every purchase a different amount — the weight-sold signature.
      bookLines(weighed.id, [2.7, 3.38, 5.45, 6.09]),
      // A 2x+ spread, but only two prices repeated: a sale, not a scale.
      bookLines(packaged.id, [2, 2, 2, 4, 4, 4]),
      // Prices all distinct but well under the 2x spread floor.
      bookLines(narrow.id, [4.01, 4.32, 4.55, 4.77]),
    ]);

    const rows = (await findFastProblems(ctx.db)).weightSoldProducts;
    const ids = rows.map((row) => row.id);

    expect(ids).toContain(weighed.id);
    expect(ids).not.toContain(packaged.id);
    expect(ids).not.toContain(narrow.id);

    expect(rows.find((row) => row.id === weighed.id)).toMatchObject({
      name: "Weighed test produce",
      lineCount: 4,
      distinctPriceFraction: 1,
      lowUnitCost: 2.7,
      highUnitCost: 6.09,
      ingredientId: null,
    });
  });

  it("stops reporting a product once it has a weight-to-money mapping", async () => {
    const mapped = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Mapped test produce",
        unitMappings: [
          {
            a: { value: 1, unit: "lb" },
            b: { value: 3, unit: "dollar" },
            source: "test",
          },
        ],
      }),
      ctx.actor,
    );
    await bookLines(mapped.id, [2.7, 3.38, 5.45, 6.09]);

    const ids = (await findFastProblems(ctx.db)).weightSoldProducts.map(
      (row) => row.id,
    );

    // The mapping IS the fix, so keeping the row would make the section
    // permanently red for a product that no longer has the problem.
    expect(ids).not.toContain(mapped.id);
  });
});

describe("title-size suggestions — food eligibility", () => {
  const ctx = withTestDb();

  it("includes food and explicit food links while excluding unrelated sizes from samples and counts", async () => {
    const linkedIngredient = await createIngredientFixture(
      ctx.db,
      { name: "Example flour", aliases: [] },
      ctx.actor,
    );
    // Raw inserts preserve legacy categories instead of createProduct's automatic
    // food classification, so each independent eligibility signal is exercised.
    const eligible = [];
    for (const data of [
      { name: "Example oats 500 g", categoryId: taxonomyId("food") },
      { name: "Example flour 1 kg", ingredientId: linkedIngredient.entityId },
      { name: "Example rice 2 lb", fdc_id: 12345 },
    ] as const) {
      eligible.push(
        await insertWithShortcode(ctx.db, "product", {
          manufacturer: "Example",
          ...data,
        }),
      );
    }
    for (const data of [
      { name: "Example line 10 lb", categoryId: taxonomyId("tools") },
      { name: "Example pot 1 gal", categoryId: taxonomyId("household") },
      { name: "Example unclassified 500 g", fdc_id: 0 },
      { name: "Example invalid food link 500 g", fdc_id: -1 },
      { name: "Example unknown 500 g" },
      { name: "Example multipack 6 x 500 g", categoryId: taxonomyId("food") },
    ] as const) {
      await insertWithShortcode(ctx.db, "product", {
        manufacturer: "Example",
        ...data,
      });
    }
    await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Example mapped oats 500 g",
        categoryId: taxonomyShortcode("food"),
        unitMappings: [
          {
            a: { value: 1, unit: "each" },
            b: { value: 500, unit: "g" },
            source: "test",
          },
        ],
      }),
      ctx.actor,
    );
    const deleted = await insertWithShortcode(ctx.db, "product", {
      manufacturer: "Example",
      name: "Example deleted food 500 g",
      categoryId: taxonomyId("food"),
    });
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, deleted.id));

    const sample = await runDiagnostic(
      ctx.db,
      "title-derivable-unit-size",
      {},
      { kind: "sample", limit: 100 },
    );
    const count = await runDiagnostic(
      ctx.db,
      "title-derivable-unit-size",
      {},
      { kind: "count" },
    );
    expect(sample.items).toHaveLength(eligible.length);
    expect(sample.items).toEqual(
      expect.arrayContaining(
        eligible.map((row) => expect.objectContaining({ id: row.shortcode })),
      ),
    );
    expect(count.count).toBe(eligible.length);
  });
});

describe("Problems maintenance coordinator", () => {
  const ctx = withTestDb();
  const context = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );

  it("preserves one empty progress event and the public result", async () => {
    const prune = [];
    for await (const event of pruneAllUnusedAliasesWorkflow(context()))
      prune.push(event);
    expect(prune).toEqual([
      { type: "progress", done: 0, total: 0 },
      { type: "done", result: { pruned: 0 } },
    ]);
    const reparse = [];
    for await (const event of reparseStaleWorkflow(context()))
      reparse.push(event);
    expect(reparse).toEqual([
      { type: "progress", done: 0, total: 0 },
      { type: "done", result: { updated: 0, recipesAffected: 0 } },
    ]);
  });

  it("does not prune on early close and commits the selected alias batch once", async () => {
    for (const name of ["Batch salt", "Batch pepper"]) {
      await createIngredientFixture(
        ctx.db,
        { name, aliases: [`${name} alias`] },
        ctx.actor,
      );
    }
    const aliases = () =>
      getDb(ctx.db).select({ aliases: ingredient.aliases }).from(ingredient);
    const before = await aliases();
    const stream = pruneAllUnusedAliasesWorkflow(context());
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "progress", done: 0, total: 2 },
    });
    await stream.return();
    expect(await aliases()).toEqual(before);
    const events = [];
    for await (const event of pruneAllUnusedAliasesWorkflow(context()))
      events.push(event);
    expect(events).toEqual([
      { type: "progress", done: 0, total: 2 },
      { type: "progress", done: 2, total: 2 },
      { type: "done", result: { pruned: 2 } },
    ]);
    expect(await aliases()).toEqual([{ aliases: [] }, { aliases: [] }]);
  });
  it("rolls back the entire prune batch when a later ingredient write fails", async () => {
    for (const name of ["Atomic first", "Atomic second"]) {
      await createIngredientFixture(
        ctx.db,
        { name, aliases: [`${name} alias`] },
        ctx.actor,
      );
    }
    await getDb(ctx.db).execute(sql`
      ALTER TABLE "Ingredient" ADD CONSTRAINT fixture_reject_empty_alias
      CHECK (name <> 'Atomic second' OR cardinality(aliases) > 0)
    `);
    const stream = pruneAllUnusedAliasesWorkflow(context());
    await stream.next();
    await expect(stream.next()).rejects.toMatchObject({
      cause: { constraint: "fixture_reject_empty_alias" },
    });
    const rows = await getDb(ctx.db)
      .select({ name: ingredient.name, aliases: ingredient.aliases })
      .from(ingredient)
      .orderBy(ingredient.name);
    expect(rows).toEqual([
      { name: "Atomic first", aliases: ["Atomic first alias"] },
      { name: "Atomic second", aliases: ["Atomic second alias"] },
    ]);
  });
});
