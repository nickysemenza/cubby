/**
 * Stale-parse detection and the re-parse write path.
 *
 * Re-parsing every captured raw line with the *current* parser to flag drift
 * (the CPU sweep behind Settings → Maintenance), the cheap DB-only count of
 * reparseable lines, and the atomic write that commits the service's reparsed
 * values.
 */

import type { Amount } from "@cubby/schemas/codec";
import type { IngredientId } from "@cubby/schemas/identifiers";
import type { StaleIngredientParse } from "@cubby/schemas/problems";
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { computeParseDrift, hasDrift } from "~/lib/parse-drift";
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

// StaleIngredientParse (staleIngredientParseSchema): a stored ingredient
// occurrence whose original raw line, re-parsed with the *current* parser, now
// differs from what's stored on any axis (name, amounts, modifier) — parsed by an
// older parser; a re-parse would change it. All drift is equal; the per-axis
// booleans drive only how the panel sorts/styles.
export const findStaleIngredientParses = async (
  db: Database,
): Promise<StaleIngredientParse[]> => {
  // No vocab here — the parser is the single source of truth. Re-parse every
  // captured raw line with the current parser and flag the rows whose result
  // drifted from what's stored. Excludes recipe-link ingredients (system-named
  // "Recipe: <name>"), which legitimately differ from a plain re-parse.
  const rows = await getDb(db)
    .select({
      recipeSectionIngredientId: recipeSectionIngredient.id,
      rawLine: recipeSectionIngredient.rawLine,
      storedAmounts: recipeSectionIngredient.amounts,
      storedModifier: recipeSectionIngredient.modifier,
      ingredientId: ingredient.id,
      storedName: ingredient.name,
      storedAliases: ingredient.aliases,
      recipeId: recipe.id,
      recipeName: recipe.name,
    })
    .from(recipeSectionIngredient)
    .innerJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
    )
    .innerJoin(
      recipeSection,
      eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
    )
    .innerJoin(recipe, eq(recipe.id, recipeSection.recipeId))
    .where(
      and(
        notDeleted(recipeSectionIngredient),
        isNotNull(recipeSectionIngredient.rawLine),
        isNull(ingredient.recipeId),
        notDeleted(recipe),
      ),
    );

  // Re-parse each line and diff it field-by-field against what's stored, via the same
  // computeParseDrift the client surfaces use. Name matching is alias-aware (so "large
  // eggs" parsing to the alias-bearing "large brown eggs" ingredient is NOT drift); the
  // amount/modifier axes are strict — the parser is the single normalizer.
  // The DB fetch above is auto-traced; this WASM re-parse + drift diff over every
  // recipe line is the CPU sweep (suspected 30–60s). Trace it with line/stale
  // counts so the cost is attributable.
  return withTrace(TraceNames.wasm("reparseStaleLines"), async (span) => {
    const stale: StaleIngredientParse[] = [];
    for (const row of rows) {
      if (!row.rawLine) continue; // isNotNull already filtered; narrow the type
      const fresh = wasm.parse_ingredient(row.rawLine);
      const drift = computeParseDrift(
        {
          knownNames: [row.storedName, ...row.storedAliases],
          amounts: row.storedAmounts,
          modifier: row.storedModifier,
        },
        fresh,
      );
      if (!hasDrift(drift)) continue;
      stale.push({
        recipeSectionIngredientId: row.recipeSectionIngredientId,
        recipeId: row.recipeId,
        recipeName: row.recipeName,
        ingredientId: row.ingredientId,
        storedName: row.storedName,
        rawLine: row.rawLine,
        parsedName: fresh.name,
        nameDrift: drift.name !== null,
        storedAmounts: row.storedAmounts,
        // Carry the range upper bound (parser WAmount snake → persisted Amount
        // camel) so Re-parse All actually resolves range drift instead of
        // re-flagging the row forever.
        parsedAmounts: drift.amounts
          ? drift.amounts.map((a) => ({
              value: a.value,
              unit: a.unit,
              ...(a.upper_value != null ? { upperValue: a.upper_value } : {}),
            }))
          : [],
        amountDrift: drift.amounts !== null,
        storedModifier: row.storedModifier,
        parsedModifier: drift.modifier,
        modifierDrift: drift.modifier !== null,
      });
    }
    span.setAttributes({ lineCount: rows.length, staleCount: stale.length });
    return stale;
  });
};

// Cheap DB-only count of the lines findStaleIngredientParses would re-parse (live
// imported lines with a rawLine, excluding recipe-link ingredients). Powers the
// "N of M would change" denominator in the Settings → Maintenance dry run without
// running the expensive WASM sweep.
export const countReparseableLines = async (db: Database): Promise<number> => {
  const [row] = await getDb(db)
    .select({ n: count() })
    .from(recipeSectionIngredient)
    .innerJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
    )
    .innerJoin(
      recipeSection,
      eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
    )
    .innerJoin(recipe, eq(recipe.id, recipeSection.recipeId))
    .where(
      and(
        notDeleted(recipeSectionIngredient),
        isNotNull(recipeSectionIngredient.rawLine),
        isNull(ingredient.recipeId),
        notDeleted(recipe),
      ),
    );
  return row?.n ?? 0;
};

// One stale recipe-line write: the values to persist plus the row to write them
// to. The service computes these (incl. the find-or-create'd ingredientId);
// applyReparsedStaleLines just commits them atomically.
export interface ReparsedStaleLineWrite {
  recipeSectionIngredientId: string;
  values: {
    amounts?: Amount[];
    modifier?: string | null;
    ingredientId?: IngredientId;
  };
}

// Persist the reparsed stale-line writes in ONE transaction (kept atomic —
// partial reparse is harmless but the single tx is cheap). The service yields
// only AROUND this call, never inside it, so the tx isn't held open across the
// stream.
export const applyReparsedStaleLines = async (
  db: Database,
  writes: ReparsedStaleLineWrite[],
): Promise<void> => {
  await withTransaction(db, async (tx) => {
    for (const w of writes) {
      await updateAndReturn(
        tx,
        recipeSectionIngredient,
        w.values,
        eq(recipeSectionIngredient.id, w.recipeSectionIngredientId),
      );
    }
  });
};
