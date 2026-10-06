import type {
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
import { actorInRun } from "@cubby/schemas/context";
import type { ProductId, RunId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import {
  auditLog,
  product,
  productCategory,
  purchase as purchaseTable,
} from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { updateProduct } from "~/server/repo/product/crud";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { autoFillCreatedProducts } from "./post-import-autofill";

type Suggest = (
  db: Database,
  runId: RunId,
  input: FieldSuggestionsInput,
) => Promise<FieldSuggestionsOut>;

const pick = (
  target: string,
  value: string,
  probability: number,
): FieldSuggestionsOut => ({
  suggestions: {
    [target]: {
      value,
      label: value,
      detail: null,
      confidence: "high",
      probability,
      reasoning: "synthetic",
      alternatives: [],
      operation: "set",
      removals: [],
    },
  },
  outcomes: {
    [target]: {
      kind: "evaluated",
      answer: "pick",
      confidence: "high",
      probability,
      alternatives: [],
    },
  },
});

// A Product an import just created gets the fields Jev is nearly certain of.
// Failure modes: a sub-0.95 guess is written; a field the member already set,
// or sets while Jev decides, is overwritten; a Product the import only linked
// is touched; a later target ignores the category just applied; an
// ingredient link skips the Product's food-category rule; a stalled
// suggestion holds the committed import's tool call open; the write leaves
// no audit trail back to the import run.
describe("auto-fill after an import", () => {
  const ctx = withTestDb();

  async function seed() {
    // Any run id works: auto-fill keys on the audit trail, not the purpose.
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Autofill Seeds ${crypto.randomUUID()}`,
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "AF-1",
      date: "2026-09-21",
      // Principal lines need a trade before any category change validates.
      defaultTrade: "other",
    });
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: `Vegetable seeds ${crypto.randomUUID()}`,
    });
    const otherCategory = await insertWithShortcode(ctx.db, "productCategory", {
      name: `Herb seeds ${crypto.randomUUID()}`,
    });
    const plant = await insertWithShortcode(ctx.db, "plant", {
      name: "Example Sun Tomato",
    });
    const newProduct = (name: string) =>
      insertWithShortcode(ctx.db, "product", { name, manufacturer: "" });
    const created = await newProduct("Example Sun Tomato seed packet");
    const preset = await newProduct("Example basil seed packet");
    const linked = await newProduct("Example trowel");
    for (const row of [created, preset, linked])
      await insertWithShortcode(ctx.db, "expense", {
        name: row.name,
        purchaseId: purchase.id,
        productId: row.id,
        cost: 3,
        date: "2026-09-21",
        lineKind: "principal",
        costType: "materials",
      });
    for (const row of [created, preset])
      await logAuditEntry(ctx.db, actorInRun(ctx.actor, runId), {
        entityKind: "product",
        entityId: row.id,
        action: "create",
      });
    await getDb(ctx.db)
      .update(product)
      .set({ categoryId: otherCategory.id })
      .where(eq(product.id, preset.id));
    return {
      runId,
      purchase,
      category,
      otherCategory,
      plant,
      created,
      preset,
      linked,
    };
  }

  const fieldsOf = async (id: ProductId) =>
    (
      await getDb(ctx.db)
        .select({
          categoryId: product.categoryId,
          growsPlantId: product.growsPlantId,
          ingredientId: product.ingredientId,
        })
        .from(product)
        .where(eq(product.id, id))
    )[0];

  it("writes only near-certain picks into empty fields of Products the import created", async () => {
    const seeded = await seed();
    const calls: FieldSuggestionsInput[] = [];
    const suggest: Suggest = async (_db, _runId, input) => {
      calls.push(input);
      const [target] = input.targets;
      if (target === "categoryId")
        return pick(target, seeded.category.shortcode, 0.97);
      if (target === "growsPlantId")
        return pick(target, seeded.plant.shortcode, 0.99);
      return pick(target!, "ING-ZZZZ", 0.9);
    };

    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      { suggest },
    );

    expect(await fieldsOf(seeded.created.id)).toMatchObject({
      categoryId: seeded.category.id,
      growsPlantId: seeded.plant.id,
      // 0.90 is below the bar.
      ingredientId: null,
    });
    // The member's category stays; the linked Product is untouched.
    expect((await fieldsOf(seeded.preset.id))?.categoryId).toBe(
      seeded.otherCategory.id,
    );
    expect(await fieldsOf(seeded.linked.id)).toMatchObject({
      categoryId: null,
      growsPlantId: null,
    });
    expect(
      calls.some((call) => call.entityId === seeded.linked.shortcode),
    ).toBe(false);
    // Later targets see the category the first pick applied.
    expect(
      calls.find(
        (call) =>
          call.entityId === seeded.created.shortcode &&
          call.targets[0] === "growsPlantId",
      )?.basis.categoryId,
    ).toBe(seeded.category.shortcode);
    const audits = await getDb(ctx.db)
      .select({ runId: auditLog.runId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, seeded.created.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((audit) => audit.runId === seeded.runId)).toBe(true);
  });

  it("keeps a value the member sets while Jev is deciding", async () => {
    const seeded = await seed();
    const suggest: Suggest = async (_db, _runId, input) => {
      const [target] = input.targets;
      if (target === "categoryId")
        await getDb(ctx.db)
          .update(product)
          .set({ categoryId: seeded.otherCategory.id })
          .where(eq(product.id, seeded.created.id));
      return pick(target!, seeded.category.shortcode, 0.99);
    };
    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      { suggest },
    );
    expect((await fieldsOf(seeded.created.id))?.categoryId).toBe(
      seeded.otherCategory.id,
    );
  });

  it("applies the Product food rule when it links an ingredient", async () => {
    const seeded = await seed();
    // The live `food` root the Product food rule resolves to.
    const [food] = await getDb(ctx.db)
      .select({ id: productCategory.id })
      .from(productCategory)
      .where(
        and(eq(productCategory.feature, "food"), notDeleted(productCategory)),
      )
      .limit(1);
    const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
      name: `example tomato ${crypto.randomUUID()}`,
    });
    const suggest: Suggest = async (_db, _runId, input) => {
      const [target] = input.targets;
      if (target === "ingredientId")
        return pick(target, ingredient.shortcode, 0.99);
      return pick(target!, seeded.category.shortcode, 0.5);
    };
    const recomputed: string[][] = [];
    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      {
        suggest,
        recomputeForIngredients: async (_db, ids) => {
          recomputed.push(ids);
          return 0;
        },
      },
    );
    // Recipes costed through the newly linked ingredient go stale.
    expect(recomputed).toEqual([[ingredient.id]]);
    expect(await fieldsOf(seeded.created.id)).toMatchObject({
      ingredientId: ingredient.id,
      categoryId: food?.id,
    });
  });

  it("never replaces a non-food category the member sets while Jev links an ingredient", async () => {
    const seeded = await seed();
    const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
      name: `example tomato ${crypto.randomUUID()}`,
    });
    const suggest: Suggest = async (_db, _runId, input) => {
      const [target] = input.targets;
      if (target === "ingredientId") {
        await getDb(ctx.db)
          .update(product)
          .set({ categoryId: seeded.otherCategory.id })
          .where(eq(product.id, seeded.created.id));
        return pick(target, ingredient.shortcode, 0.99);
      }
      return pick(target!, seeded.category.shortcode, 0.5);
    };
    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      { suggest, recomputeForIngredients: async () => 0 },
    );
    expect(await fieldsOf(seeded.created.id)).toMatchObject({
      categoryId: seeded.otherCategory.id,
      ingredientId: null,
    });
  });

  it("keeps filling a Product's other fields after one is refused", async () => {
    const seeded = await seed();
    const suggest: Suggest = async (_db, _runId, input) => {
      const [target] = input.targets;
      if (target === "growsPlantId")
        return pick(target, seeded.plant.shortcode, 0.99);
      // A category that no longer exists refuses that one write.
      return pick(target!, "CAT-ZZZZ", 0.99);
    };
    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      { suggest, recomputeForIngredients: async () => 0 },
    );
    expect(await fieldsOf(seeded.created.id)).toMatchObject({
      categoryId: null,
      growsPlantId: seeded.plant.id,
    });
  });

  it("writes nothing from an answer that arrives after the budget", async () => {
    const seeded = await seed();
    const suggest: Suggest = async (_db, _runId, input) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return pick(input.targets[0]!, seeded.category.shortcode, 0.99);
    };
    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      { suggest, budgetMs: 100 },
    );
    // Let the late answer land, then confirm it wrote nothing.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await fieldsOf(seeded.created.id))?.categoryId).toBeNull();
  });

  it("links an ingredient under a food subcategory that inherits food", async () => {
    const seeded = await seed();
    const [food] = await getDb(ctx.db)
      .select({ id: productCategory.id })
      .from(productCategory)
      .where(
        and(eq(productCategory.feature, "food"), notDeleted(productCategory)),
      )
      .limit(1);
    const rice = await insertWithShortcode(ctx.db, "productCategory", {
      name: `Example rice ${crypto.randomUUID()}`,
      parentId: food!.id,
    });
    const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
      name: `example jasmine rice ${crypto.randomUUID()}`,
    });
    const suggest: Suggest = async (_db, _runId, input) => {
      const [target] = input.targets;
      if (target === "categoryId") return pick(target, rice.shortcode, 0.99);
      if (target === "ingredientId")
        return pick(target, ingredient.shortcode, 0.99);
      return pick(target!, seeded.plant.shortcode, 0.5);
    };
    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      { suggest, recomputeForIngredients: async () => 0 },
    );
    expect(await fieldsOf(seeded.created.id)).toMatchObject({
      categoryId: rice.id,
      ingredientId: ingredient.id,
    });
  });

  it("writes nothing after waiting on the row lock past the budget", async () => {
    const seeded = await seed();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A member's edit holds the Product row without changing the category.
    const holder = withTransaction(ctx.db, async (tx) => {
      await tx
        .select({ id: product.id })
        .from(product)
        .where(eq(product.id, seeded.created.id))
        .for("update");
      locked();
      await held;
    });
    await lockTaken;
    const suggest: Suggest = async (_db, _runId, input) =>
      pick(input.targets[0]!, seeded.category.shortcode, 0.99);
    const fill = autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      { suggest, budgetMs: 200 },
    );
    await fill;
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await holder;
    // Give the waiting write its turn, then confirm it wrote nothing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await fieldsOf(seeded.created.id))?.categoryId).toBeNull();
  });

  it("rolls back a write whose Product update finishes past the budget", async () => {
    const seeded = await seed();
    const suggest: Suggest = async (_db, _runId, input) =>
      pick(input.targets[0]!, seeded.category.shortcode, 0.99);
    let finished!: () => void;
    const writeDone = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      {
        suggest,
        budgetMs: 200,
        // The real update, then a wait on a dependent row past the budget.
        writeProduct: async (...args) => {
          const out = await updateProduct(...args);
          await new Promise((resolve) => setTimeout(resolve, 400));
          finished();
          return out;
        },
      },
    );
    await writeDone;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await fieldsOf(seeded.created.id))?.categoryId).toBeNull();
  });

  // A meal order classified as a restaurant is what tells data quality and
  // receiving it holds no stock. Failure modes: an empty Purchase category is
  // left for a person when Jev is near-certain; a category that forbids
  // Products is forced onto an order that already links one.
  it("fills an empty Purchase category unless the category forbids its Products", async () => {
    const seeded = await seed();
    const restaurants = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Example restaurants ${crypto.randomUUID()}`,
      productExpectation: "not_allowed",
    });
    const dining = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Example dining ${crypto.randomUUID()}`,
    });
    const categoryOf = async () =>
      (
        await getDb(ctx.db)
          .select({ id: purchaseTable.spendingCategoryId })
          .from(purchaseTable)
          .where(eq(purchaseTable.id, seeded.purchase.id))
      )[0]?.id;
    const run = (category: { shortcode: string }) =>
      autoFillCreatedProducts(
        ctx.db,
        { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
        {
          suggest: async (_db, _runId, input) =>
            input.entity === "purchase"
              ? pick("spendingCategoryId", category.shortcode, 0.99)
              : pick(input.targets[0]!, "CAT-ZZZZ", 0.1),
          recomputeForIngredients: async () => 0,
        },
      );
    // This order links Products, so a Product-forbidding category is refused.
    await run(restaurants);
    expect(await categoryOf()).toBeNull();
    await run(dining);
    expect(await categoryOf()).toBe(dining.id);
  });

  it("returns at its budget when a suggestion stalls", async () => {
    const seeded = await seed();
    const suggest: Suggest = () => new Promise(() => undefined);
    const started = Date.now();
    await autoFillCreatedProducts(
      ctx.db,
      { runId: seeded.runId, purchaseIds: [seeded.purchase.id] },
      { suggest, budgetMs: 200 },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await fieldsOf(seeded.created.id))?.categoryId).toBeNull();
  });
});
