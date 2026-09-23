import type { ActorContext } from "@cubby/schemas/context";
/**
 * Ingredient CRUD operations.
 * Core create / update / read-by-id plus the find-or-create and batch
 * resolve-or-create primitives.
 */
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type IngredientId,
  type IngredientShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type {
  IngredientWithRecipesAndProductOut,
  ingredientCreateInput,
  ingredientUpdateData,
} from "@cubby/schemas/ingredient";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { ingredient, product } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  notDeleted,
  relations,
  unwrapDb,
  updateAndReturn,
  withTransactionOn,
} from "~/server/repo/database-helpers";
import { createEntityCrud } from "~/server/repo/entity-crud-factory";
import { patchEntityRows } from "~/server/repo/entity-patch";
import { markProductConversionCoverageInputStale } from "~/server/repo/product/conversion-coverage";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";

import { buildIngredientWhere, type IngredientDeepDB } from "./internal-types";
import { dbIngredientToAPI } from "./mappers";

// getByID + update run through the shared CRUD factory (the 404, before-state→
// audit, re-fetch→map orchestration). create/find-or-create stay hand-rolled:
// they accept the Database | DrizzleTransaction union and own ingredient-specific
// alias-dedupe / race semantics.
const fetchIngredientById = async (
  // The union, not `Database`: the factory's `update` runs on a transaction and
  // reads the before-state through this. `dbIngredientToAPI` (the `fromDB`)
  // already takes the union and ignores the handle, so nothing else widens.
  db: Database | DrizzleTransaction,
  id: IngredientId,
): Promise<IngredientDeepDB | undefined> => {
  const row = await unwrapDb(db).query.ingredient.findFirst({
    where: and(eq(ingredient.id, id), notDeleted(ingredient)),
    ...relations.ingredient.full,
  });
  return row;
};

const ingredientCrud = createEntityCrud({
  table: ingredient,
  entity: "ingredient",
  fetchById: fetchIngredientById,
  fromDB: (db, row: IngredientDeepDB) => dbIngredientToAPI(db, row),
  toUpdate: (data: z.infer<typeof ingredientUpdateData>) => data,
  auditUpdateFields: [...entityFieldModels.ingredient.audit],
});

export const getIngredientByID = (
  db: Database,
  id: IngredientId,
): Promise<IngredientWithRecipesAndProductOut> =>
  ingredientCrud.getByID(db, id);

export const createIngredient = async (
  db: Database | DrizzleTransaction,
  data: z.input<typeof ingredientCreateInput>,
  actor: ActorContext,
): Promise<IngredientWithRecipesAndProductOut> => {
  const newIngredient = await insertWithShortcode(db, "ingredient", {
    name: data.name,
    aliases: data.aliases || [],
    naKinds: data.naKinds ?? [],
    usuallyOnHand: data.usuallyOnHand ?? false,
  });

  // Log audit entry
  await logAuditEntry(db, actor, {
    entityType: "ingredient",
    entityId: newIngredient.id,
    action: "create",
  });

  const ingredientData = await unwrapDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, newIngredient.id),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    // INTERNAL_SERVER_ERROR (500): the row was just written, so its absence is a
    // genuine internal fault, not a missing-entity 404. No createAppError reason
    // maps to 500 here, and matches the sibling pattern in recipe/crud.ts.
    throw new Error("Failed to fetch created ingredient");
  }

  return await dbIngredientToAPI(db, ingredientData);
};

/**
 * Accepts an open transaction as well as the pooled handle, matching
 * `createIngredient` above: the factory's `update` joins a caller's transaction
 * rather than opening its own, so an importer that creates a recipe and renames
 * its ingredients can keep the whole thing atomic.
 */
export const updateIngredient = async (
  db: Database | DrizzleTransaction,
  id: IngredientId,
  data: z.infer<typeof ingredientUpdateData>,
  actor: ActorContext,
): Promise<IngredientWithRecipesAndProductOut> =>
  withTransactionOn(db, async (tx) => {
    const updated = await ingredientCrud.update(tx, id, data, actor);
    if (data.naKinds !== undefined) {
      const linked = await tx
        .select({ id: product.id })
        .from(product)
        .where(and(eq(product.ingredientId, id), notDeleted(product)));
      await markProductConversionCoverageInputStale(
        tx,
        linked.map((row) => row.id),
      );
    }
    return updated;
  });

/** Bulk pantry-planning setting update. Inventory rows are deliberately never
 * selected or written here: this changes only an ingredient-level assumption. */
export const updateIngredientsUsuallyOnHand = async (
  db: Database,
  ids: IngredientId[],
  data: Pick<z.infer<typeof ingredientUpdateData>, "usuallyOnHand">,
  actor: ActorContext,
): Promise<IngredientId[]> => {
  const updated = await patchEntityRows(
    db,
    actor,
    {
      entity: "ingredient",
      table: ingredient,
      fields: entityFieldModels.ingredient.bulk,
    },
    ids,
    data,
  );
  return updated.map((row) => row.id);
};

export const findOrCreateIngredient = async (
  db: Database | DrizzleTransaction,
  name: string,
  aliases?: string[],
) => {
  // Atomic find-or-create. The `Ingredient_name_key` unique index is on
  // lower(name) (partial, WHERE deletedAt IS NULL), so it agrees with the
  // case-insensitive matcher — "Flour" and "flour" collide and dedupe rather
  // than both inserting. See findOrCreate for the race it closes.
  const { row: entry } = await findOrCreateWithShortcode(db, "ingredient", {
    where: buildIngredientWhere(true, name, aliases),
    values: () => ({
      name,
      aliases: aliases || [],
    }),
  });

  // Add new aliases, deduped CASE-INSENSITIVELY against the name and existing
  // aliases (and against each other). Matching is case-insensitive, so appending
  // a casing-variant of an existing alias/name would only add noise to the array.
  const nameLower = name.toLowerCase();
  const seenLower = new Set(entry.aliases.map((a) => a.toLowerCase()));
  const aliasesToAdd = (aliases ?? []).filter((alias) => {
    const lower = alias.toLowerCase();
    if (lower === nameLower || seenLower.has(lower)) return false;
    seenLower.add(lower); // also dedupes casing-variants within `aliases` itself
    return true;
  });

  if (aliasesToAdd.length === 0) {
    return entry;
  }

  return await updateAndReturn(
    db,
    ingredient,
    {
      name: name,
      aliases: [...entry.aliases, ...aliasesToAdd],
    },
    and(eq(ingredient.id, entry.id), notDeleted(ingredient)),
  );
};

type ResolvedIngredient = {
  name: string;
  id: IngredientShortcode;
  entityId: IngredientId;
  /** The row's own name/aliases — not the requested name, which may be a
   * casing variant or an alias of it. */
  canonicalName: string;
  aliases: string[];
  matched: boolean;
  created: boolean;
};

// Batch resolve-or-create: for each requested name, find the existing standalone
// ingredient (case-insensitive on name/aliases) or atomically create it, reusing
// the same matcher + race-safe `findOrCreate` primitive as findOrCreateIngredient.
// Returns one entry per non-blank input name in order, so an agent/MCP caller can
// collapse dozens of search+create round-trips into one call. Duplicate or
// casing-variant names dedupe to a single DB op; a name matching another's alias
// resolves to that existing ingredient (no duplicate row).
export const resolveOrCreateIngredients = async (
  db: Database | DrizzleTransaction,
  names: string[],
): Promise<ResolvedIngredient[]> => {
  const resolved = new Map<
    string,
    {
      id: IngredientId;
      shortcode: IngredientShortcode;
      canonicalName: string;
      aliases: string[];
      created: boolean;
    }
  >();
  const requested = new Set<string>();

  const uniqueNames: string[] = [];
  for (const rawName of names) {
    const name = rawName.trim();
    const key = name.toLowerCase();
    if (key.length === 0 || requested.has(key)) continue;
    // Reserve the key before the lookup so casing variants coalesce.
    requested.add(key);
    uniqueNames.push(name);
  }

  if (uniqueNames.length > 0) {
    // Fetch all already-existing name/alias matches at once, avoiding a
    // find-or-create SELECT per input — a cookbook-sized request is
    // overwhelmingly existing ingredients.
    const existing = await unwrapDb(db).query.ingredient.findMany({
      where: buildIngredientWhere(true, uniqueNames[0]!, uniqueNames.slice(1)),
      columns: { id: true, shortcode: true, name: true, aliases: true },
    });
    for (const row of existing) {
      const entry = {
        id: row.id,
        shortcode: parseShortcodeFor("ingredient", row.shortcode),
        canonicalName: row.name,
        aliases: row.aliases,
        created: false,
      };
      for (const matchName of [row.name, ...row.aliases]) {
        const key = matchName.toLowerCase();
        if (requested.has(key)) resolved.set(key, entry);
      }
    }
  }

  for (const name of uniqueNames) {
    const key = name.toLowerCase();
    if (resolved.get(key)) continue;
    const { row, created } = await findOrCreateWithShortcode(db, "ingredient", {
      where: buildIngredientWhere(true, name),
      values: () => ({
        name,
        aliases: [],
      }),
    });
    resolved.set(key, {
      id: row.id,
      shortcode: parseShortcodeFor("ingredient", row.shortcode),
      canonicalName: row.name,
      aliases: row.aliases,
      created,
    });
  }

  const out: ResolvedIngredient[] = [];
  for (const rawName of names) {
    const entry = resolved.get(rawName.trim().toLowerCase());
    if (!entry) continue; // blank/whitespace-only name
    out.push({
      name: rawName,
      id: entry.shortcode,
      entityId: entry.id,
      canonicalName: entry.canonicalName,
      aliases: entry.aliases,
      matched: !entry.created,
      created: entry.created,
    });
  }
  return out;
};
