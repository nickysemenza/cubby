/**
 * Cookbook repository.
 *
 * A `Cookbook` is a first-class recipe source: the book a set of EPUB-extracted
 * recipes came from. It stores the full assembled `ImportRecipe[]` (`rawJson`)
 * so recipes can be re-derived without re-running the LLM, plus OPF metadata.
 * Recipes link to it via `recipe.cookbookId`; cookbook-scoped recipe queries live
 * in the recipe repo (`./recipe`).
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type CookbookId,
  type CookbookShortcode,
  type RecipeId,
  unsafeCookbookShortcode,
} from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { CookbookSummary } from "@cubby/schemas/recipe";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { cookbook, image, recipe } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { runWithConflictRecovery } from "~/server/errors/db-errors";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { countByTarget, impact, present } from "~/server/repo/impact";
import {
  type CookbookImportContext,
  upsertCookbookRecipeFromCookbook,
} from "~/server/repo/import-recipe-convert";
import {
  deleteRecipesByCookbookTx,
  getCookbookRecipeIdsByTitle,
  getCookbookRecipeTitles,
} from "~/server/repo/recipe";
import { removeEntity } from "~/server/repo/removal";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export const COOKBOOK_DELETE_EDGE_POLICY = {
  "Recipe.cookbookId": {
    code: "cascade-delete-entity",
    effect: "soft-delete",
    description:
      "Deleting a cookbook soft-deletes every recipe it produced, along with their sections, images, and meal associations.",
  },
} as const satisfies IncomingEdgePolicy<"cookbook", OperationDisposition>;

// Everything an import knows about a cookbook before its recipes are written: the
// book name plus the full extraction and OPF metadata. `author`/`subjects` default
// to empty (the power-user JSON path has no EPUB to read metadata from).
type CookbookUpsertInput = {
  name: string;
  rawJson: ImportRecipe[];
  author?: string[];
  subjects?: string[];
  sourceLabel: string;
  // The uploaded cover Image id. Only set when provided — a metadata-only / re-open
  // upsert (no cover) must never clear an existing cover.
  coverImageId?: string;
};

/**
 * Create or update a cookbook by name (the unique key). Called **once at the
 * start of an import**, before any recipe insert, so the FK target exists; a
 * re-import refreshes `rawJson` + metadata in place. A `Cookbook` only ever
 * exists fully-formed — there is no lazy, metadata-less creation.
 */
export const upsertCookbook = async (
  db: Database,
  input: CookbookUpsertInput,
  actor: ActorContext,
): Promise<{ output: { id: CookbookShortcode }; entityId: CookbookId }> => {
  const values = {
    name: input.name,
    rawJson: input.rawJson,
    author: input.author ?? [],
    subjects: input.subjects ?? [],
    sourceLabel: input.sourceLabel,
    importedAt: new Date(),
    // Omit when not provided so an update can't null out an existing cover.
    ...(input.coverImageId ? { coverImageId: input.coverImageId } : {}),
  };

  const matchWhere = and(eq(cookbook.name, input.name), notDeleted(cookbook));

  // Insert (existingId === null) or update one cookbook row, then associate the
  // cover image and log the audit entry — all in one transaction.
  const commit = (
    existingId: CookbookId | null,
  ): Promise<{ output: { id: CookbookShortcode }; entityId: CookbookId }> =>
    withTransaction(db, async (tx) => {
      const row = existingId
        ? await updateAndReturn(
            tx,
            cookbook,
            values,
            eq(cookbook.id, existingId),
          )
        : await insertWithShortcode(tx, "cookbook", values);
      const id = row.id;

      // The cover image is now associated → mark it uploaded (it was PENDING from
      // the presigned upload, like the recipe/product image flow).
      if (input.coverImageId) {
        await tx
          .update(image)
          .set({ status: "UPLOADED" })
          .where(eq(image.id, input.coverImageId));
      }

      await logAuditEntry(tx, actor, {
        entityType: "cookbook",
        entityId: id,
        action: existingId ? "update" : "create",
      });
      return {
        output: { id: unsafeCookbookShortcode(row.shortcode) },
        entityId: id,
      };
    });

  const existing = await getDb(db).query.cookbook.findFirst({
    where: matchWhere,
    columns: { id: true },
  });
  if (existing) {
    return commit(existing.id);
  }

  // No match: insert. `commit(null)` runs the INSERT in its own transaction, so a
  // concurrent same-name import that wins the race makes this txn abort on
  // `Cookbook_name_key` and fully roll back; we then re-SELECT the winner and
  // update it instead of 500ing.
  return runWithConflictRecovery(
    () => commit(null),
    async (error) => {
      const winner = await getDb(db).query.cookbook.findFirst({
        where: matchWhere,
        columns: { id: true },
      });
      if (!winner) throw error;
      return commit(winner.id);
    },
    "Cookbook_name_key",
  );
};

/** A non-deleted cookbook by name, or null. */
export const getCookbookByName = async (db: Database, name: string) => {
  const row = await getDb(db).query.cookbook.findFirst({
    where: and(eq(cookbook.name, name), notDeleted(cookbook)),
  });
  return row ?? null;
};

/** A non-deleted cookbook by id, or null. */
const getCookbookById = async (db: Database, id: CookbookId) => {
  const row = await getDb(db).query.cookbook.findFirst({
    where: and(eq(cookbook.id, id), notDeleted(cookbook)),
  });
  return row ?? null;
};

/**
 * Cookbooks with their non-deleted recipe counts, for the browse index. A left
 * join keeps cookbooks with zero current recipes visible.
 */
export const listCookbooks = async (
  db: Database,
): Promise<CookbookSummary[]> => {
  const rows = await getDb(db)
    .select({
      id: cookbook.id,
      shortcode: cookbook.shortcode,
      book: cookbook.name,
      author: cookbook.author,
      subjects: cookbook.subjects,
      recipeCount: sql<number>`count(${recipe.id})::int`,
      coverUrl: image.url,
      sourceRecipeCount: sql<number>`coalesce(jsonb_array_length(${cookbook.rawJson}), 0)::int`,
    })
    .from(cookbook)
    .leftJoin(
      recipe,
      and(eq(recipe.cookbookId, cookbook.id), notDeleted(recipe)),
    )
    .leftJoin(image, eq(image.id, cookbook.coverImageId))
    .where(notDeleted(cookbook))
    .groupBy(cookbook.id, image.url)
    .orderBy(cookbook.name);
  return rows.map((r) => ({
    ...r,
    id: unsafeCookbookShortcode(r.shortcode),
    coverUrl: r.coverUrl ?? null,
  }));
};

/**
 * The cookbook's stored extraction (`rawJson`) + identity, so the importer can
 * re-open it for selective re-import. No recipe writes here — importing reuses
 * the `importCookbookStream` path with these recipes.
 */
export const getCookbookSource = async (
  db: Database,
  id: CookbookId,
): Promise<{ id: CookbookId; name: string; recipes: ImportRecipe[] }> => {
  const cb = await getCookbookById(db, id);
  if (!cb) {
    throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
  }
  return { id, name: cb.name, recipes: cb.rawJson };
};

/**
 * Delete a cookbook and everything imported from it, in one transaction: the
 * recipe cascade (sections / ingredients / images / embeddings / audit) runs via
 * {@link deleteRecipesByCookbookTx}, then the `Cookbook` row is soft-deleted so
 * the book leaves the browse index instead of lingering as an empty shell.
 * Returns the deleted recipe ids so the caller can run mutation side-effects and
 * recompute the surviving parent recipes.
 */
export const deleteCookbook = async (
  db: Database,
  id: CookbookId,
  actor: ActorContext,
): Promise<{ deletedRecipeIds: RecipeId[] }> => {
  const cb = await getCookbookById(db, id);
  if (!cb) {
    throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
  }

  return withTransaction(db, async (tx) => {
    // A whole second entity's removal path, nested in this one's transaction so
    // a book can't survive its recipes. It covers the recipes' rows, cascades,
    // and embeddings; the call below covers the book's own.
    const deletedRecipeIds = await deleteRecipesByCookbookTx(tx, id, actor);

    await removeEntity(tx, {
      entity: "cookbook",
      ids: [id],
      removal: "soft",
      actor,
    });

    return { deletedRecipeIds };
  });
};

/** Final summary of a reprocess pass (the generator's `return` value). */
type ReprocessSummary = {
  reprocessed: number;
  importableExtras: string[];
  recipeIds: RecipeId[];
};

/**
 * Re-derive a cookbook's already-imported recipes from its stored `rawJson` —
 * re-running the ingredient/yield parser (WASM, **no LLM**) so a parser upgrade
 * applies without re-uploading the EPUB. Recipes are matched by title; recipes in
 * `rawJson` that were never imported are returned as `importableExtras` rather
 * than auto-created, preserving the user's original selection.
 *
 * Streamed: `yield`s `{ done, total }` after each upsert so the caller can drive a
 * progress bar, and `return`s the summary (incl. the upserted ids for one batched
 * recompute). `total` counts only the recipes actually reprocessed — the skipped
 * extras are near-free, so excluding them keeps the bar honest.
 */
export async function* reprocessCookbookStream(
  db: Database,
  id: CookbookId,
  actor: ActorContext,
): AsyncGenerator<
  { done: number; total: number; recipeId?: RecipeId },
  ReprocessSummary
> {
  const cb = await getCookbookById(db, id);
  if (!cb) {
    throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
  }

  const existing = new Set(
    (await getCookbookRecipeTitles(db, id)).map((t) => t.trim().toLowerCase()),
  );
  const cookbookRef = { id, name: cb.name };
  const matched = (cr: ImportRecipe) =>
    existing.has(cr.meta.title.trim().toLowerCase());

  // Already-imported recipes get re-derived; the rest are reported as extras.
  const toReprocess = cb.rawJson.filter(matched);
  const importableExtras = cb.rawJson
    .filter((cr) => !matched(cr))
    .map((cr) => cr.meta.title);

  const total = toReprocess.length;
  // Shared context for the loop: running title map (forward refs in-memory) +
  // ingredient id cache (resolve a repeated ingredient once). See the import
  // path in routers/recipe.ts.
  const importCtx: CookbookImportContext = {
    titleToId: await getCookbookRecipeIdsByTitle(db, id),
    ingredientIdByName: new Map(),
  };
  // The upserted recipe ids, so the caller can recompute their totals eagerly.
  const recipeIds: RecipeId[] = [];
  let done = 0;
  for (const cr of toReprocess) {
    const { id: recipeId } = await upsertCookbookRecipeFromCookbook(
      cr,
      cookbookRef,
      db,
      actor,
      importCtx,
    );
    recipeIds.push(recipeId);
    done++;
    yield { done, total, recipeId };
  }
  return { reprocessed: total, importableExtras, recipeIds };
}

/**
 * What {@link deleteCookbook} would do to the given cookbook(s), without doing
 * it.
 *
 * Reads the SAME `COOKBOOK_DELETE_EDGE_POLICY` `deleteCookbook` is described
 * by. Its one incoming edge, `Recipe.cookbookId`, is a `soft-delete` cascade —
 * there is nothing to block on, so `blockers` is always empty — counted with
 * the identical `eq(recipe.cookbookId, cookbookId) AND notDeleted(recipe)`
 * predicate {@link deleteRecipesByCookbookTx} fetches its recipe ids with (via
 * {@link countByTarget}).
 *
 * Cookbook delete is single-id (`entityManifest.cookbook.lifecycle.delete.bulk
 * === false`), but this still takes/returns the standard planner shape rather
 * than a bespoke one-id signature — callers can assume `ids.length === 1`
 * without the type forcing every caller to special-case cookbook.
 *
 * This is the highest-value preview in the PR: `useCookbookDelete`'s confirm
 * dialog today carries static prose ("Recipes used as a sub-recipe elsewhere
 * or currently planned into a meal are deleted too, with no separate
 * warning") in place of a live count — this planner is what turns that prose
 * into a number.
 *
 * Advisory only. `deleteCookbook` still re-runs its own cascade
 * (`deleteRecipesByCookbookTx`) inside its own transaction.
 */
export const previewDeleteCookbooks = async (
  db: Database,
  ids: CookbookId[],
): Promise<{ blockers: ImpactItem[]; changes: ImpactItem[] }> => {
  if (ids.length === 0) return { blockers: [], changes: [] };

  const disposition = COOKBOOK_DELETE_EDGE_POLICY["Recipe.cookbookId"];
  const changes = present([
    impact({
      disposition,
      edgeKey: "Recipe.cookbookId",
      label: "imported recipes",
      byTargetId: await countByTarget(
        getDb(db),
        recipe,
        recipe.cookbookId,
        ids,
      ),
    }),
  ]);

  return { blockers: [], changes };
};
