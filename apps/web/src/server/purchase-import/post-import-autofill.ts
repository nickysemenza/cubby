import {
  actorInRun,
  buildActorContext,
  type ActorContext,
} from "@cubby/schemas/context";
import { parseEntityId, userId, type RunId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq } from "drizzle-orm";

import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import type { Database } from "~/server/db";
import {
  auditLog,
  product,
  productCategory,
  run as runTable,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { patchEntityRows } from "~/server/repo/entity-patch";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

const log = createLogger("post-import-autofill");

/** Jev's calibrated probability a pick must reach to be written unreviewed. */
export const AUTO_FILL_PROBABILITY = 0.95;

/**
 * Filled in this order: the category is part of the ingredient and plant
 * bases, so they are asked after it lands. Each picks from existing records
 * only; auto-fill never creates an Ingredient or a Plant.
 */
const AUTO_FILL_TARGETS = [
  { field: "categoryId", entity: "productCategory" },
  { field: "ingredientId", entity: "ingredient" },
  { field: "growsPlantId", entity: "plant" },
] as const;

type AutoFillPorts = { suggest: typeof suggestFields };

/**
 * After an import commits, fill the empty category, ingredient, and plant of
 * each Product that import created when Jev is at least
 * {@link AUTO_FILL_PROBABILITY} sure. A Product the import only linked, and
 * any field already set, are left alone. Writes are audited under the import
 * run, so the Product's history names where the value came from. Best-effort
 * per Product: a failed suggestion is logged and never fails the import.
 */
export async function autoFillCreatedProducts(
  db: Database,
  input: { runId: RunId },
  ports: AutoFillPorts = { suggest: suggestFields },
) {
  const created = await getDb(db)
    .selectDistinct({ id: auditLog.entityId })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.runId, input.runId),
        eq(auditLog.entityKind, "product"),
        eq(auditLog.action, "create"),
      ),
    );
  if (created.length === 0) return;
  const [run] = await getDb(db)
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
      try {
        await autoFillProduct(db, { runId: input.runId, actor }, id, ports);
      } catch (error) {
        log.warn("Product auto-fill skipped", { productId: id, error });
      }
    }),
  );
}

async function autoFillProduct(
  db: Database,
  { runId, actor }: { runId: RunId; actor: ActorContext },
  productId: string,
  ports: AutoFillPorts,
) {
  for (const target of AUTO_FILL_TARGETS) {
    const row = await loadBasis(db, productId);
    if (!row || row[target.field] !== null) continue;
    const out = await ports.suggest(db, runId, {
      entity: "product",
      entityId: row.shortcode,
      basisMode: "suggested",
      targets: [target.field],
      basis: {
        name: row.name,
        manufacturer: row.manufacturer || null,
        model: row.model,
        notes: row.notes,
        categoryId: row.categoryShortcode,
      },
    });
    const outcome = out.outcomes?.[target.field];
    const value = out.suggestions[target.field]?.value;
    if (
      outcome?.kind !== "evaluated" ||
      outcome.answer !== "pick" ||
      (outcome.probability ?? 0) < AUTO_FILL_PROBABILITY ||
      !value
    )
      continue;
    const resolved = await resolveOrThrow(db, target.entity, value);
    await patchEntityRows(
      db,
      actor,
      {
        entity: "product",
        table: product,
        fields: AUTO_FILL_TARGETS.map((target) => target.field),
      },
      [productId],
      { [target.field]: resolved },
    );
  }
}

async function loadBasis(db: Database, productId: string) {
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
    .where(
      and(
        eq(product.id, parseEntityId("product", productId)),
        notDeleted(product),
      ),
    )
    .limit(1);
  return row ?? null;
}
