/**
 * Cookbook repository.
 *
 * A `Cookbook` is a first-class recipe source: the book a set of EPUB-extracted
 * recipes came from. It stores the extracted book tree (`rawJson`, the
 * `cookbook` crate's `Cookbook`) so recipes can be re-derived without
 * re-running the models, the run report (`report`) with every call and cost,
 * and OPF metadata. Recipes link to it via `recipe.cookbookId`;
 * cookbook-scoped recipe queries live in the recipe repo (`./recipe`).
 *
 * Rows written before the tree format hold an `ImportRecipe[]` in `rawJson`;
 * they are flagged `needsReextract` and cannot be imported from until the
 * EPUB is extracted again.
 */

import type { ActorContext } from "@cubby/schemas/context";
import {
  type CookbookExtraction,
  type CookbookRecipe,
  type CookbookRunReport,
  cookbookExtractionSchema,
  flattenCookbookRecipes,
  isLegacyCookbookRawJson,
} from "@cubby/schemas/cookbook";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type CookbookId,
  type CookbookShortcode,
  type ProductId,
  parseShortcodeFor,
  type RecipeId,
} from "@cubby/schemas/identifiers";
import type { CookbookSummary } from "@cubby/schemas/recipe";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  cookbook,
  entityAttachment,
  image,
  product,
  recipe,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { runWithConflictRecovery } from "~/server/errors/db-errors";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  getDb,
  notDeleted,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import {
  type CookbookImportContext,
  upsertCookbookRecipeFromCookbook,
} from "~/server/repo/import-recipe-convert";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product";
import {
  deleteRecipesByCookbookTx,
  getCookbookRecipeIdsByTitle,
  getCookbookRecipeTitles,
} from "~/server/repo/recipe";
import { deleteByPolicy } from "~/server/repo/removal";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  replaceSingularAttachment,
  singularAttachmentImageIds,
} from "~/server/repo/singular-attachment";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

export const COOKBOOK_DELETE_EDGE_POLICY = {
  "EntityAttachment.subjectEntityId": {
    code: "cascade-delete-attachment",
    effect: "soft-delete",
    description:
      "The cover association is soft-deleted with the cookbook; the cover image is reaped when nothing else uses it.",
  },
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
  rawJson: CookbookExtraction;
  report?: CookbookRunReport | null;
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
  const values: Omit<typeof cookbook.$inferInsert, "shortcode"> = {
    name: input.name,
    rawJson: input.rawJson,
    report: input.report ?? null,
    sourceRecipeCount: flattenCookbookRecipes(input.rawJson).length,
    author: input.author ?? [],
    subjects: input.subjects ?? [],
    sourceLabel: input.sourceLabel,
    importedAt: new Date(),
  };

  const matchWhere = and(eq(cookbook.name, input.name), notDeleted(cookbook));

  // Insert (existingId === null) or update one cookbook row, then associate the
  // cover image and log the audit entry — all in one transaction.
  const commit = (
    existingId: CookbookId | null,
  ): Promise<{ output: { id: CookbookShortcode }; entityId: CookbookId }> =>
    withTransaction(db, async (tx) => {
      // A metadata-only re-open upsert (no cover) must never clear a cover,
      // and a re-import never replaces one already chosen.
      const hasCover = existingId
        ? (await singularAttachmentImageIds(tx, [existingId], "cover")).has(
            existingId,
          )
        : false;
      const shouldAttachCover = input.coverImageId !== undefined && !hasCover;
      const row = existingId
        ? await updateAndReturn(
            tx,
            cookbook,
            values,
            eq(cookbook.id, existingId),
          )
        : await insertWithShortcode(tx, "cookbook", values);
      const id = row.id;
      if (shouldAttachCover && input.coverImageId) {
        await replaceSingularAttachment(tx, id, "cover", input.coverImageId);
      }

      // The cover image is now associated → mark it uploaded (it was PENDING from
      // the presigned upload, like the recipe/product image flow).
      if (shouldAttachCover && input.coverImageId) {
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
        output: { id: parseShortcodeFor("cookbook", row.shortcode) },
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
 * The `readCookbookSummaries` predicate, with no filters of its own beyond
 * soft-delete and an optional single-shortcode narrowing. Exported so
 * `getEntityCounts` can call `cookbookListWhere()` and get the browse index's
 * REAL population rather than a hand-restated copy that can drift from it.
 */
export const cookbookListWhere = (shortcode?: CookbookShortcode) =>
  and(
    notDeleted(cookbook),
    shortcode ? eq(cookbook.shortcode, shortcode) : undefined,
  );

/**
 * Cookbooks with their non-deleted recipe counts, for the browse index. A left
 * join keeps cookbooks with zero current recipes visible.
 */
const readCookbookSummaries = async (
  db: Database,
  shortcode?: CookbookShortcode,
): Promise<CookbookSummary[]> => {
  const rows = await getDb(db)
    .select({
      id: cookbook.id,
      shortcode: cookbook.shortcode,
      book: cookbook.name,
      author: cookbook.author,
      subjects: cookbook.subjects,
      recipeCount: sql<number>`count(${recipe.id})::int`,
      coverKey: image.key,
      sourceRecipeCount: cookbook.sourceRecipeCount,
      // Rows from before the book-tree format hold a flat array.
      needsReextract: sql<boolean>`jsonb_typeof(${cookbook.rawJson}) = 'array'`,
      productId: cookbook.productId,
      productShortcode: product.shortcode,
      productName: product.name,
    })
    .from(cookbook)
    .leftJoin(
      recipe,
      and(eq(recipe.cookbookId, cookbook.id), notDeleted(recipe)),
    )
    .leftJoin(
      entityAttachment,
      and(
        eq(entityAttachment.subjectEntityId, cookbook.id),
        eq(entityAttachment.role, "cover"),
        notDeleted(entityAttachment),
      ),
    )
    .leftJoin(image, eq(image.id, entityAttachment.imageId))
    .leftJoin(
      product,
      and(eq(product.id, cookbook.productId), notDeleted(product)),
    )
    .where(cookbookListWhere(shortcode))
    .groupBy(cookbook.id, image.key, product.id)
    .orderBy(cookbook.name);

  // The linked product's own cover, via the shared batched reader rather than a
  // third join — ProductImage carries the cover flag, so inlining it here would
  // mean duplicating that resolution.
  const [productCovers, dataQualities] = await Promise.all([
    getProductCoverImageUrlsByProductIds(
      db,
      rows.flatMap((r) => (r.productId ? [r.productId] : [])),
    ),
    loadDataQualities(
      db,
      "cookbook",
      rows.map((r) => r.id),
    ),
  ]);

  return withDisplayImages(
    db,
    "cookbook",
    rows,
    ({ productId, productShortcode, productName, coverKey, ...r }) => ({
      ...r,
      id: parseShortcodeFor("cookbook", r.shortcode),
      coverUrl: coverKey ? getR2PublicUrl(coverKey) : null,
      product:
        productId && productShortcode && productName
          ? {
              id: parseShortcodeFor("product", productShortcode),
              name: productName,
              coverUrl: productCovers.get(productId) ?? null,
            }
          : null,
      // SAFETY: `r` came from `rows`, which `dataQualities` was loaded for.
      dataQuality: dataQualities.get(r.id)!,
    }),
  );
};

export const listCookbooks = async (db: Database): Promise<CookbookSummary[]> =>
  await readCookbookSummaries(db);

export const getCookbookSummary = async (
  db: Database,
  shortcode: CookbookShortcode,
): Promise<CookbookSummary | null> =>
  (await readCookbookSummaries(db, shortcode))[0] ?? null;

/**
 * Point a cookbook at the physical copy on the shelf, or clear the link
 * (`productId: null`). Always operator-driven and always one book at a time:
 * matching by title is unsafe (see the `Cookbook.productId` column comment —
 * "Tartine Book No. 3" and "Tartine: A Classic Revisited" are different books),
 * so nothing in the codebase writes this without a human choosing the product.
 *
 * No uniqueness guard on the product side. Two cookbooks claiming one copy is
 * odd but harmless — nothing derives money or stock from this edge — and a
 * partial unique index would not survive `db:push` anyway.
 */
export const setCookbookProduct = async (
  db: Database,
  actor: ActorContext,
  id: CookbookId,
  productId: ProductId | null,
): Promise<CookbookSummary> => {
  const shortcode = await withTransaction(db, async (tx) => {
    const before = await tx.query.cookbook.findFirst({
      where: and(eq(cookbook.id, id), notDeleted(cookbook)),
      columns: { productId: true },
    });
    if (!before) {
      throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
    }
    const updated = await updateAndReturn(
      tx,
      cookbook,
      { productId },
      and(eq(cookbook.id, id), notDeleted(cookbook)),
    );
    await logAuditEntry(tx, actor, {
      entityType: "cookbook",
      entityId: id,
      action: "update",
      changes: { productId: { from: before.productId, to: productId } },
    });
    return parseShortcodeFor("cookbook", updated.shortcode);
  });

  // Re-read through the shared projection outside the transaction so the
  // caller gets the same hydrated shape as the browse index without loading
  // every cookbook for a one-row mutation result.
  const summary = await getCookbookSummary(db, shortcode);
  if (!summary) {
    throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
  }
  return summary;
};

/**
 * The stored book tree, parsed. A legacy flat array (pre-tree rows) is a
 * `COOKBOOK_SOURCE_STALE` error: those books must be re-extracted from the
 * EPUB before anything can be imported from them.
 */
const parseStoredExtraction = (
  id: CookbookId,
  rawJson: CookbookExtraction,
): CookbookExtraction => {
  if (isLegacyCookbookRawJson(rawJson)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Cookbook ${id} was extracted with a retired format; re-extract it from the EPUB`,
    );
  }
  return cookbookExtractionSchema.parse(rawJson);
};

/**
 * The cookbook's stored extraction (`rawJson`) + report + identity, so the
 * importer can re-open it for selective re-import. No recipe writes here —
 * importing reuses the `importCookbookStream` path with these recipe ids.
 */
export const getCookbookSource = async (
  db: Database,
  id: CookbookId,
): Promise<{
  id: CookbookId;
  name: string;
  cookbook: CookbookExtraction;
  report: CookbookRunReport | null;
}> => {
  const cb = await getCookbookById(db, id);
  if (!cb) {
    throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
  }
  return {
    id,
    name: cb.name,
    cookbook: parseStoredExtraction(id, cb.rawJson),
    report: cb.report ?? null,
  };
};

/** `Recipe.id` → recipe item, for every recipe in the tree. */
export const cookbookRecipesById = (
  extraction: CookbookExtraction,
): Map<string, { recipe: CookbookRecipe; chapter: string | null }> =>
  new Map(
    flattenCookbookRecipes(extraction).map((entry) => [entry.recipe.id, entry]),
  );

/**
 * Resolve a source recipe's photo only when it still belongs to the requested
 * live recipe (matched by the item's unique `name`, which the import stamps
 * as the recipe name). Returns the first photo's archive reference.
 */
export const getCookbookRecipePhotoSource = async (
  db: Database,
  cookbookId: CookbookId,
  recipeId: RecipeId,
  sourceRecipeId: string,
) => {
  const cb = await getCookbookById(db, cookbookId);
  if (!cb) {
    throw createAppError("COOKBOOK_NOT_FOUND", "Cookbook not found");
  }
  const source = cookbookRecipesById(
    parseStoredExtraction(cookbookId, cb.rawJson),
  ).get(sourceRecipeId);
  if (!source) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Recipe ${sourceRecipeId} is not in this cookbook's extraction`,
    );
  }
  const photo = source.recipe.photos[0];
  if (!photo) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The selected cookbook recipe has no photo in the EPUB",
    );
  }

  const target = await getDb(db).query.recipe.findFirst({
    where: and(
      eq(recipe.id, recipeId),
      eq(recipe.cookbookId, cookbookId),
      eq(recipe.name, source.recipe.name),
      notDeleted(recipe),
    ),
    columns: { id: true },
  });
  if (!target) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Recipe does not match the selected cookbook source",
    );
  }

  return { path: photo.path, mime: photo.mime };
};

/**
 * Delete a cookbook and everything imported from it, in one transaction: the
 * `"Recipe.cookbookId"` edge is overridden to run the recipe cascade
 * ({@link deleteRecipesByCookbookTx} — sections / ingredients / images /
 * embeddings / audit) instead of the policy's default per-column soft-delete,
 * and the `Cookbook` row itself (plus its cover attachment, per
 * {@link COOKBOOK_DELETE_EDGE_POLICY}) is removed by the same
 * {@link deleteByPolicy} call. Returns the deleted recipe ids so the caller
 * can run mutation side-effects and recompute the surviving parent recipes.
 */
export const deleteCookbook = async (
  db: Database,
  id: CookbookId,
  actor: ActorContext,
): Promise<{ deletedRecipeIds: RecipeId[]; detachedImageKeys: string[] }> => {
  const cb = await getCookbookById(db, id);
  if (!cb) {
    throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
  }

  // The override can't return a value, so the recipe cascade's ids/detached
  // keys are captured here and merged with the root removal's own result
  // below.
  let deletedRecipeIds: RecipeId[] = [];
  let recipeImageKeys: string[] = [];

  const { detachedImageKeys } = await deleteByPolicy(db, {
    entity: "cookbook",
    policy: COOKBOOK_DELETE_EDGE_POLICY,
    ids: [id],
    actor,
    overrides: {
      "Recipe.cookbookId": async (tx) => {
        const result = await deleteRecipesByCookbookTx(tx, id, actor);
        deletedRecipeIds = result.recipeIds;
        recipeImageKeys = result.detachedImageKeys;
      },
    },
  });

  return {
    deletedRecipeIds,
    detachedImageKeys: [...recipeImageKeys, ...detachedImageKeys],
  };
};

export type CookbookReprocessSelection = {
  readonly recipes: readonly {
    readonly recipe: CookbookRecipe;
    readonly chapter: string | null;
  }[];
  readonly cookbook: { readonly id: CookbookId; readonly name: string };
  readonly importContext: CookbookImportContext;
  readonly importableExtras: readonly string[];
};

/**
 * Re-derive a cookbook's already-imported recipes from its stored `rawJson` —
 * re-running the ingredient/yield parser (WASM, **no LLM**) so a parser upgrade
 * applies without re-uploading the EPUB. Recipes are matched by title; recipes in
 * `rawJson` that were never imported are returned as `importableExtras` rather
 * than auto-created, preserving the user's original selection.
 *
 * Selection is separate from each reprocess write so a declarative stream can
 * keep the same honest total without inventing an item for importable extras.
 */
export const prepareCookbookReprocessing = async (
  db: Database,
  id: CookbookId,
): Promise<CookbookReprocessSelection> => {
  const cb = await getCookbookById(db, id);
  if (!cb) {
    throw createAppError("COOKBOOK_NOT_FOUND", `Cookbook ${id} not found`);
  }

  const existing = new Set(
    (await getCookbookRecipeTitles(db, id)).map((t) => t.trim().toLowerCase()),
  );
  const cookbook = { id, name: cb.name };
  const extraction = parseStoredExtraction(id, cb.rawJson);
  const all = flattenCookbookRecipes(extraction);
  const matched = (entry: (typeof all)[number]) =>
    existing.has(entry.recipe.name.trim().toLowerCase());

  // Already-imported recipes get re-derived; the rest are reported as extras.
  const toReprocess = all.filter(matched);
  const importableExtras = all
    .filter((entry) => !matched(entry))
    .map((entry) => entry.recipe.name);

  // Shared context for the loop: running title map (forward refs in-memory),
  // the tree (item id → name, for sub-recipe links) and an ingredient id
  // cache (resolve a repeated ingredient once).
  const importCtx: CookbookImportContext = {
    titleToId: await getCookbookRecipeIdsByTitle(db, id),
    extraction,
    ingredientIdByName: new Map(),
  };
  return {
    recipes: toReprocess,
    cookbook,
    importContext: importCtx,
    importableExtras,
  };
};

/** Reprocess one selected recipe against the shared title and ingredient maps. */
export const reprocessCookbookRecipe = async (
  db: Database,
  selection: CookbookReprocessSelection,
  entry: CookbookReprocessSelection["recipes"][number],
  actor: ActorContext,
): Promise<RecipeId> =>
  (
    await upsertCookbookRecipeFromCookbook(
      entry.recipe,
      entry.chapter,
      selection.cookbook,
      db,
      actor,
      selection.importContext,
    )
  ).id;
