import {
  actorInRun,
  buildActorContext,
  type ActorContext,
} from "@cubby/schemas/context";
import {
  userId,
  type IngredientId,
  type ProductId,
  type PurchaseId,
  type RunId,
} from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, inArray } from "drizzle-orm";

import { env } from "~/env";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { getBindingFetcher } from "~/server/cf-env";
import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import {
  auditLog,
  expense,
  product,
  productCategory,
  run as runTable,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { getCategoryFeature } from "~/server/repo/product-category";
import { updateProduct } from "~/server/repo/product/crud";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { RecipeCostingService } from "~/server/services/recipe-costing.service";

const log = createLogger("post-import-autofill");

/** Jev's calibrated probability a pick must reach to be written unreviewed. */
const AUTO_FILL_PROBABILITY = 0.95;

/**
 * The commit tool call waits for auto-fill, so it gets a fixed budget: no new
 * suggestion starts after it, and the call returns when it elapses.
 */
const AUTO_FILL_BUDGET_MS = 20_000;

/**
 * Filled in this order: the category is part of the ingredient and plant
 * bases, so they are asked after it lands. Each picks from existing records
 * only; auto-fill never creates an Ingredient or a Plant.
 */
const AUTO_FILL_TARGETS = [
  "categoryId",
  "ingredientId",
  "growsPlantId",
] as const;

type AutoFillTarget = (typeof AUTO_FILL_TARGETS)[number];
type AutoFillPorts = {
  suggest: typeof suggestFields;
  /** Recipes costed through a newly linked ingredient go stale. */
  recomputeForIngredients?: (
    db: Database,
    ingredientIds: IngredientId[],
  ) => Promise<number>;
  budgetMs?: number;
  /** The Product write; tests wrap it to stall past the budget. */
  writeProduct?: typeof updateProduct;
};

/** Thrown inside the write transaction to roll back a write that outlived the budget. */
class AutoFillBudgetElapsed extends Error {}

const productionRecompute: NonNullable<
  AutoFillPorts["recomputeForIngredients"]
> = (db, ingredientIds) =>
  new RecipeCostingService(
    db,
    new USDAClient(env.USDA_API_URL, getBindingFetcher("USDA_API")),
  ).recomputeForIngredients(ingredientIds, { source: "product.autofill" });

/**
 * After an import commits, fill the empty category, ingredient, and plant of
 * each Product this run created on these Purchases when Jev is at least
 * {@link AUTO_FILL_PROBABILITY} sure. A Product the import only linked, a
 * field already set, and a field a member sets while Jev decides are left
 * alone. The write goes through the ordinary Product update (its category
 * rules and audit), as the import's actor scoped to its run. Best-effort and
 * bounded: any failure is logged and never fails the committed import.
 */
export async function autoFillCreatedProducts(
  db: Database,
  input: { runId: RunId; purchaseIds: readonly PurchaseId[] },
  ports: AutoFillPorts = { suggest: suggestFields },
) {
  const budgetMs = ports.budgetMs ?? AUTO_FILL_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([fillAll(db, input, ports, deadline), elapsed]);
  } catch (error) {
    log.warn("Product auto-fill skipped", { runId: input.runId, error });
  } finally {
    clearTimeout(timer);
  }
}

async function fillAll(
  db: Database,
  input: { runId: RunId; purchaseIds: readonly PurchaseId[] },
  ports: AutoFillPorts,
  deadline: number,
) {
  if (input.purchaseIds.length === 0) return;
  const database = getDb(db);
  const created = await database
    .selectDistinct({ id: product.id })
    .from(expense)
    .innerJoin(product, eq(product.id, expense.productId))
    .innerJoin(
      auditLog,
      and(
        eq(auditLog.entityId, product.id),
        eq(auditLog.entityKind, "product"),
        eq(auditLog.action, "create"),
        eq(auditLog.runId, input.runId),
      ),
    )
    .where(
      and(
        inArray(expense.purchaseId, [...input.purchaseIds]),
        notDeleted(expense),
        notDeleted(product),
      ),
    );
  if (created.length === 0) return;
  const [run] = await database
    .select({ actorUserId: runTable.actorUserId })
    .from(runTable)
    .where(eq(runTable.id, input.runId))
    .limit(1);
  if (!run) return;
  // The import's own actor, scoped to its run, so history reads as the import.
  const actor = actorInRun(
    buildActorContext(userId.parse(run.actorUserId), "system"),
    input.runId,
  );
  await Promise.all(
    created.map(async ({ id }) => {
      for (const target of AUTO_FILL_TARGETS) {
        if (Date.now() >= deadline) return;
        // One refused field (a domain rule, a failed suggestion) never
        // skips the Product's other fields.
        try {
          await fillTarget(
            db,
            { runId: input.runId, actor, deadline },
            id,
            target,
            ports,
          );
        } catch (error) {
          log.warn("Product auto-fill skipped", {
            productId: id,
            field: target,
            error,
          });
        }
      }
    }),
  );
}

async function fillTarget(
  db: Database,
  {
    runId,
    actor,
    deadline,
  }: { runId: RunId; actor: ActorContext; deadline: number },
  productId: ProductId,
  target: AutoFillTarget,
  ports: AutoFillPorts,
) {
  const row = await loadBasis(db, productId);
  // The read can outlast the budget; no suggestion starts after it.
  if (!row || row[target] !== null || Date.now() >= deadline) return;
  const out = await ports.suggest(db, runId, {
    entity: "product",
    entityId: row.shortcode,
    basisMode: "suggested",
    targets: [target],
    basis: {
      name: row.name,
      manufacturer: row.manufacturer || null,
      model: row.model,
      notes: row.notes,
      categoryId: row.categoryShortcode,
    },
  });
  const outcome = out.outcomes?.[target];
  const value = out.suggestions[target]?.value;
  if (
    outcome?.kind !== "evaluated" ||
    outcome.answer !== "pick" ||
    (outcome.probability ?? 0) < AUTO_FILL_PROBABILITY ||
    !value
  )
    return;
  const patch = await patchFor(db, target, value);
  let written: boolean;
  try {
    written = await withTransaction(db, async (tx) => {
      // Re-read under the row lock: a member who filled the field, or changed
      // the category the pick was based on, while Jev decided keeps their value.
      const [locked] = await tx
        .select({
          categoryId: product.categoryId,
          ingredientId: product.ingredientId,
          growsPlantId: product.growsPlantId,
        })
        .from(product)
        .where(and(eq(product.id, productId), notDeleted(product)))
        .for("update")
        .limit(1);
      // Checked once the lock is held: past the budget the commit already
      // returned and enrichment may have fingerprinted the Product, so a late
      // answer, or one that waited on the lock, writes nothing.
      if (Date.now() >= deadline) return false;
      if (
        !locked ||
        locked[target] !== null ||
        locked.categoryId !== row.categoryId
      )
        return false;
      // An ingredient link files the Product under food; it never replaces a
      // category that is not food, counting a feature inherited from an
      // ancestor ("Rice" under a food root).
      if (
        target === "ingredientId" &&
        locked.categoryId !== null &&
        (await getCategoryFeature(tx, locked.categoryId)) !== "food"
      )
        return false;
      await (ports.writeProduct ?? updateProduct)(
        databaseForTransaction(tx),
        productId,
        patch,
        actor,
      );
      // The update itself can wait on dependent rows; one that finished past
      // the budget rolls back rather than commit after the import returned.
      if (Date.now() >= deadline) throw new AutoFillBudgetElapsed();
      return true;
    });
  } catch (error) {
    if (!(error instanceof AutoFillBudgetElapsed)) throw error;
    written = false;
  }
  if (!written) return;
  await runMutationSideEffectsForEntities(
    db,
    mutationEvents("product", "updated", [productId], "product.autofill"),
  );
  if ("ingredientId" in patch && patch.ingredientId)
    await (ports.recomputeForIngredients ?? productionRecompute)(db, [
      patch.ingredientId,
    ]);
}

async function patchFor(db: Database, target: AutoFillTarget, value: string) {
  switch (target) {
    case "categoryId":
      return { categoryId: await resolveOrThrow(db, "productCategory", value) };
    case "ingredientId":
      return { ingredientId: await resolveOrThrow(db, "ingredient", value) };
    case "growsPlantId":
      return { growsPlantId: await resolveOrThrow(db, "plant", value) };
  }
}

async function loadBasis(db: Database, productId: ProductId) {
  const [row] = await getDb(db)
    .select({
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      model: product.model,
      notes: product.notes,
      categoryId: product.categoryId,
      ingredientId: product.ingredientId,
      growsPlantId: product.growsPlantId,
      categoryShortcode: productCategory.shortcode,
    })
    .from(product)
    .leftJoin(productCategory, eq(productCategory.id, product.categoryId))
    .where(and(eq(product.id, productId), notDeleted(product)))
    .limit(1);
  return row ?? null;
}
