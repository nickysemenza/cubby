/**
 * Ingredient-centric Problems detectors.
 *
 * Recipe-used ingredients with no product (uncostable), ingredients carrying
 * unused/redundant aliases (a WASM parse-sweep over every live line), unused
 * ingredients (split by linked-product), and the alias-pruning fix.
 */

import type { IngredientId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { IngredientWithUnusedAliases } from "@cubby/schemas/problems";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { computeUnusedAliases } from "~/lib/unused-aliases";
import { wasm } from "~/lib/wasm";
import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { TraceNames, withTrace } from "~/server/tracing";

// Find ingredients carrying ≥1 "unused" alias — one that's redundant (case-only
// dup of the name / an earlier alias) or never matched by a recipe line. We
// re-parse every live recipe line with the current parser (same machinery as
// findStaleIngredientParses) to learn which names actually resolve to which
// ingredient, then ask the pure computeUnusedAliases for the verdict per row.
// Excludes sub-recipe pointers (recipeId set), which carry system names, not aliases.
export const findIngredientsWithUnusedAliases = async (
  db: Database,
): Promise<IngredientWithUnusedAliases[]> => {
  const dbClient = getDb(db);

  // Map<lower(parsedName), Set<ingredientId>>: for each live recipe line, the
  // ingredient its re-parsed name resolved to. An alias is "matched" iff this
  // map ties its lowercased value to its own ingredient.
  //
  // selectDistinct: the SQL execution is ~6ms but marshalling every row back
  // through Hyperdrive/node-postgres on workerd costs ~0.75ms/row (6684 rows ≈
  // 5s — the dominant cost). Identical (rawLine, ingredientId) pairs are pure
  // waste here: the parse is deterministic and the target is a Set, so deduping
  // server-side (6684 → ~4231 rows) cuts both the transfer AND the parse loop by
  // ~37% with byte-identical output. The HashAggregate adds ~3ms server-side —
  // a trivial price for thousands of fewer rows over the wire.
  const lineRows = await dbClient
    .selectDistinct({
      rawLine: recipeSectionIngredient.rawLine,
      ingredientId: ingredient.id,
    })
    .from(recipeSectionIngredient)
    .innerJoin(
      ingredient,
      and(
        eq(ingredient.id, recipeSectionIngredient.ingredientId),
        // Output-neutral (computeUnusedAliases only ever checks a *live*
        // ingredient's id against the map — a deleted ingredient's id is never
        // queried), so dropping lines that resolve to soft-deleted ingredients
        // trims rows without changing the verdict, and matches the soft-delete
        // convention the second query already follows.
        notDeleted(ingredient),
      ),
    )
    .innerJoin(
      recipeSection,
      and(
        eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
        notDeleted(recipeSection),
      ),
    )
    .innerJoin(
      recipe,
      and(eq(recipe.id, recipeSection.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(recipeSectionIngredient),
        isNotNull(recipeSectionIngredient.rawLine),
        isNull(ingredient.recipeId),
      ),
    );

  // The DB fetch above is auto-traced (drizzle instrumentation); this WASM
  // parse-sweep over every recipe line is CPU and otherwise invisible — it's the
  // suspected 30–60s. Trace it with the line count so the cost is attributable.
  const resolvedNameToIngredientIds = await withTrace(
    TraceNames.wasm("parseAliasLines"),
    async (span) => {
      const map = new Map<string, Set<string>>();
      for (const row of lineRows) {
        if (!row.rawLine) continue; // isNotNull already filtered; narrow the type
        const fresh = wasm.parse_ingredient(row.rawLine);
        const key = fresh.name.toLowerCase();
        let ids = map.get(key);
        if (!ids) {
          ids = new Set();
          map.set(key, ids);
        }
        ids.add(row.ingredientId);
      }
      span.setAttributes({
        lineCount: lineRows.length,
        distinctNames: map.size,
      });
      return map;
    },
  );

  // Only ingredients that actually carry aliases can have unused ones.
  const withAliases = await dbClient
    .select({
      id: ingredient.id,
      shortcode: ingredient.shortcode,
      name: ingredient.name,
      aliases: ingredient.aliases,
    })
    .from(ingredient)
    .where(
      and(
        notDeleted(ingredient),
        isNull(ingredient.recipeId),
        sql`cardinality(${ingredient.aliases}) > 0`,
      ),
    );

  const problems: IngredientWithUnusedAliases[] = [];
  for (const ing of withAliases) {
    const unusedAliases = computeUnusedAliases({
      id: ing.id,
      name: ing.name,
      aliases: ing.aliases,
      resolvedNameToIngredientIds,
    });
    if (unusedAliases.length > 0) {
      problems.push({
        id: parseShortcodeFor("ingredient", ing.shortcode),
        name: ing.name,
        aliases: ing.aliases,
        unusedAliases,
      });
    }
  }
  return problems;
};

// Strip the given aliases (by value, case-insensitive) from each ingredient,
// leaving the ingredient itself intact. Used by both the per-card "Remove
// aliases" fix (one item) and the section's bulk "Remove all" (every item). The
// client passes exactly the aliases it rendered, so we never re-derive the set.
export const pruneUnusedAliases = async (
  db: Database,
  items: { ingredientId: IngredientId; remove: string[] }[],
): Promise<{ pruned: number }> => {
  let pruned = 0;
  await withTransaction(db, async (tx) => {
    for (const item of items) {
      if (item.remove.length === 0) continue;
      const removeLower = new Set(item.remove.map((a) => a.toLowerCase()));
      const row = await tx.query.ingredient.findFirst({
        where: and(
          eq(ingredient.id, item.ingredientId),
          notDeleted(ingredient),
        ),
        columns: { aliases: true },
      });
      if (!row) continue;
      const keep = row.aliases.filter((a) => !removeLower.has(a.toLowerCase()));
      if (keep.length === row.aliases.length) continue;
      pruned += row.aliases.length - keep.length;
      await updateAndReturn(
        tx,
        ingredient,
        { aliases: keep },
        eq(ingredient.id, item.ingredientId),
      );
    }
  });
  return { pruned };
};
