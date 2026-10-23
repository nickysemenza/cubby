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
  type ProductShortcode,
} from "@cubby/schemas/identifiers";
import type {
  IngredientWithRecipesAndProductOut,
  ingredientCreateInput,
  ingredientUpdateData,
} from "@cubby/schemas/ingredient";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import {
  notDeleted,
  relations,
  unwrapDb,
  updateAndReturn,
  withTransactionOn,
} from "~/server/db/helpers";
import { ingredient, product } from "~/server/db/schema";
import {
  type MutationReceipt,
  createEntityCrud,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import {
  lexicalEligibility,
  lexicalRelevance,
} from "~/server/generic/search/repo/search-lexical";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/generic/shortcode/repo/shortcode-utils";

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
  db: Database | DrizzleTransaction,
  id: IngredientId,
): Promise<IngredientWithRecipesAndProductOut> =>
  ingredientCrud.getByID(db, id);

export const createIngredient = defineMutationWriter({
  entity: "ingredient",
  read: (
    receipt: MutationReceipt<"ingredient">,
    db: Database | DrizzleTransaction,
    _data: z.input<typeof ingredientCreateInput>,
    _actor: ActorContext,
  ) => getIngredientByID(db, receipt.entityId),
  write: async (
    readOutput,
    db: Database | DrizzleTransaction,
    data: z.input<typeof ingredientCreateInput>,
    actor: ActorContext,
  ) => {
    const newIngredient = await insertWithShortcode(db, "ingredient", {
      name: data.name,
      aliases: data.aliases || [],
      naKinds: data.naKinds ?? [],
      usuallyOnHand: data.usuallyOnHand ?? false,
    });

    // Log audit entry
    await logAuditEntry(db, actor, {
      entityKind: "ingredient",
      entityId: newIngredient.id,
      action: "create",
    });

    return readOutput({
      entityId: newIngredient.id,
      shortcode: newIngredient.shortcode,
    });
  },
});

/**
 * Accepts an open transaction as well as the pooled handle, matching
 * `createIngredient` above: the factory's `update` joins a caller's transaction
 * rather than opening its own, so an importer that creates a recipe and renames
 * its ingredients can keep the whole thing atomic.
 */
export const updateIngredient = defineMutationWriter({
  entity: "ingredient",
  read: (
    receipt: MutationReceipt<"ingredient">,
    db: Database | DrizzleTransaction,
    _id: IngredientId,
    _data: z.infer<typeof ingredientUpdateData>,
    _actor: ActorContext,
  ) => getIngredientByID(db, receipt.entityId),
  write: async (
    readOutput,
    db: Database | DrizzleTransaction,
    id: IngredientId,
    data: z.infer<typeof ingredientUpdateData>,
    actor: ActorContext,
  ) =>
    withTransactionOn(db, async (tx) => {
      const updated = await ingredientCrud.update(
        tx,
        id,
        data,
        actor,
        async (_db, receipt) => receipt,
      );
      return readOutput(updated, () => ingredientCrud.getByID(tx, id));
    }),
});

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

export interface UnlinkedProductCandidate {
  id: ProductShortcode;
  name: string;
  brandName: string | null;
}

const PRODUCT_CANDIDATES_PER_INGREDIENT = 5;
/** One `UNION ALL` arm per ingredient; bounds the statement, not the input. */
const PRODUCT_CANDIDATE_MAX_INGREDIENTS = 100;

const candidateRowSchema = z.object({
  key: z.string(),
  shortcode: z.string(),
  name: z.string(),
  brandName: z.string().nullable(),
});

/**
 * Live Products with no ingredient link that read as each ingredient, ranked
 * by the command-search relevance and capped per ingredient, in one
 * statement. Advisory only: it proposes rows for a caller to link. Only the
 * first `PRODUCT_CANDIDATE_MAX_INGREDIENTS` ingredients are searched; the
 * rest map to nothing. Eligibility ANDs every name token, so an ingredient's
 * (short, generic) name must appear within the product's name.
 */
export const findUnlinkedProductCandidates = async (
  db: Database | DrizzleTransaction,
  ingredients: ReadonlyArray<{ id: IngredientShortcode; name: string }>,
): Promise<Map<IngredientShortcode, UnlinkedProductCandidate[]>> => {
  // Two requested names can resolve to one ingredient; search it once.
  const distinct = [
    ...new Map(ingredients.map((entry) => [entry.id, entry])).values(),
  ];
  const arms = distinct
    .slice(0, PRODUCT_CANDIDATE_MAX_INGREDIENTS)
    .flatMap(({ id, name }) => {
      const eligible = lexicalEligibility("product", product.id, name);
      // A name with no searchable token matches nothing rather than everything.
      if (!eligible) return [];
      return [
        sql`(
          SELECT ${id}::text AS "key", ${product.shortcode} AS "shortcode", ${product.name} AS "name", ${productBrandNameSql(product.brandId)} AS "brandName",
            row_number() OVER (ORDER BY ${lexicalRelevance("product", product.id, name)} ASC, ${product.name} ASC, ${product.shortcode} ASC) AS "rank"
          FROM ${product}
          WHERE ${and(notDeleted(product), isNull(product.ingredientId), eligible)}
          ORDER BY "rank"
          LIMIT ${PRODUCT_CANDIDATES_PER_INGREDIENT}
        )`,
      ];
    });
  const byIngredient = new Map<
    IngredientShortcode,
    UnlinkedProductCandidate[]
  >();
  if (arms.length === 0) return byIngredient;
  const result = await unwrapDb(db).execute(
    sql`SELECT * FROM (${sql.join(arms, sql` UNION ALL `)}) candidates ORDER BY "key", "rank"`,
  );
  for (const row of z.array(candidateRowSchema).parse(result.rows)) {
    const key = parseShortcodeFor("ingredient", row.key);
    byIngredient.set(key, [
      ...(byIngredient.get(key) ?? []),
      {
        id: parseShortcodeFor("product", row.shortcode),
        name: row.name,
        brandName: row.brandName,
      },
    ]);
  }
  return byIngredient;
};
