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
import type { CookbookId } from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { CookbookSummary } from "@cubby/schemas/recipe";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { cookbook, image, recipe } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  insertAndReturn,
  notDeleted,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { upsertCookbookRecipeFromCookbook } from "~/server/repo/import-recipe-convert";
import { getCookbookRecipeTitles } from "~/server/repo/recipe";

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
): Promise<{ id: CookbookId }> => {
  return withTransaction(db, async (tx) => {
    const existing = await tx.query.cookbook.findFirst({
      where: and(eq(cookbook.name, input.name), notDeleted(cookbook)),
      columns: { id: true },
    });

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

    const id = existing
      ? (
          await updateAndReturn(
            tx,
            cookbook,
            values,
            eq(cookbook.id, existing.id),
          )
        ).id
      : (await insertAndReturn(tx, cookbook, values)).id;

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
      action: existing ? "update" : "create",
    });
    return { id: id };
  });
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
    id: r.id,
    coverUrl: r.coverUrl ?? null,
  }));
};

/**
 * The cookbook's stored extraction (`rawJson`) + identity, so the importer can
 * re-open it for selective re-import. No recipe writes here — importing reuses
 * the per-recipe `insertCookbook` path with these recipes.
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
 * Re-derive a cookbook's already-imported recipes from its stored `rawJson` —
 * re-running the ingredient/yield parser (WASM, **no LLM**) so a parser upgrade
 * applies without re-uploading the EPUB. Recipes are matched by title; recipes in
 * `rawJson` that were never imported are returned as `importableExtras` rather
 * than auto-created, preserving the user's original selection.
 */
export const reprocessCookbook = async (
  db: Database,
  id: CookbookId,
  actor: ActorContext,
): Promise<{ reprocessed: number; importableExtras: string[] }> => {
  const cb = await getCookbookById(db, id);
  if (!cb) {
    throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
  }

  const existing = new Set(
    (await getCookbookRecipeTitles(db, id)).map((t) => t.trim().toLowerCase()),
  );
  const cookbookRef = { id, name: cb.name };

  let reprocessed = 0;
  const importableExtras: string[] = [];
  for (const cr of cb.rawJson) {
    if (existing.has(cr.meta.title.trim().toLowerCase())) {
      await upsertCookbookRecipeFromCookbook(cr, cookbookRef, db, actor);
      reprocessed++;
    } else {
      importableExtras.push(cr.meta.title);
    }
  }
  return { reprocessed, importableExtras };
};
