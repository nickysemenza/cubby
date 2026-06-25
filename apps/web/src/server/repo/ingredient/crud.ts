/**
 * Ingredient CRUD operations.
 * Core create / update / read-by-id plus the find-or-create and batch
 * resolve-or-create primitives.
 */

import type { IngredientWithRecipesAndProductOut } from "@cubby/schemas/combo";
import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId } from "@cubby/schemas/identifiers";
import type { ingredientBase } from "@cubby/schemas/ingredient";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Database, DrizzleTransaction } from "~/server/db";
import { ingredient } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  findOrCreate,
  getDb,
  insertAndReturn,
  notDeleted,
  relations,
  unwrapDb,
  updateAndReturn,
} from "~/server/repo/database-helpers";
import { buildIngredientWhere, dbIngredientToAPI } from "./internal-types";

export const getIngredientByID = async (db: Database, id: IngredientId) => {
  const ingredientData = await getDb(db).query.ingredient.findFirst({
    where: and(eq(ingredient.id, id), notDeleted(ingredient)),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    throw createAppError("INGREDIENT_NOT_FOUND", `Ingredient ${id} not found`);
  }

  return await dbIngredientToAPI(db, ingredientData);
};

export const createIngredient = async (
  db: Database | DrizzleTransaction,
  data: z.infer<typeof ingredientBase>,
  actor: ActorContext,
): Promise<IngredientWithRecipesAndProductOut> => {
  const newIngredient = await insertAndReturn(db, ingredient, {
    name: data.name,
    aliases: data.aliases || [],
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

export const updateIngredient = async (
  db: Database,
  id: IngredientId,
  data: Partial<z.infer<typeof ingredientBase>>,
  actor: ActorContext,
): Promise<IngredientWithRecipesAndProductOut> => {
  // Capture before state for audit logging
  const beforeState = await getDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, id),
  });

  const updated = await updateAndReturn(
    db,
    ingredient,
    data,
    eq(ingredient.id, id),
  );

  // Log audit entry with changes
  if (beforeState) {
    const changes = computeChanges(beforeState, updated, ["name", "aliases"]);
    if (changes) {
      await logAuditEntry(db, actor, {
        entityType: "ingredient",
        entityId: id,
        action: "update",
        changes,
      });
    }
  }

  const ingredientData = await getDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, updated.id),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    // INTERNAL_SERVER_ERROR (500): the row was just written, so its absence is a
    // genuine internal fault, not a missing-entity 404. No createAppError reason
    // maps to 500 here, and matches the sibling pattern in recipe/crud.ts.
    throw new Error("Failed to fetch updated ingredient");
  }

  return await dbIngredientToAPI(db, ingredientData);
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
  const { row: entry } = await findOrCreate(db, ingredient, {
    where: buildIngredientWhere(true, name, aliases),
    values: { name, aliases: aliases || [] },
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
    eq(ingredient.id, entry.id),
  );
};

type ResolvedIngredient = {
  name: string;
  id: IngredientId;
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
  const resolved = new Map<string, { id: IngredientId; created: boolean }>();

  for (const rawName of names) {
    const name = rawName.trim();
    const key = name.toLowerCase();
    if (key.length === 0 || resolved.has(key)) continue;
    const { row, created } = await findOrCreate(db, ingredient, {
      where: buildIngredientWhere(true, name),
      values: { name, aliases: [] },
    });
    resolved.set(key, { id: row.id, created });
  }

  const out: ResolvedIngredient[] = [];
  for (const rawName of names) {
    const entry = resolved.get(rawName.trim().toLowerCase());
    if (!entry) continue; // blank/whitespace-only name
    out.push({
      name: rawName,
      id: entry.id,
      matched: !entry.created,
      created: entry.created,
    });
  }
  return out;
};
