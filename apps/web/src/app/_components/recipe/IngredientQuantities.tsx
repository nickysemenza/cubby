import type { WAmount } from "@cubby/recipebridge";
import type { SectionIngredientOut } from "@cubby/schemas/recipe";
import type { RecipeCosting } from "~/lib/recipe-costing";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { tryFormatAmount } from "../inventory/format-amount";
import { EstimateMarker } from "./estimate-marker";

/**
 * One quantity to print in the gutter. `derived` grams come from the costing
 * engine (muted); `estimated` ones carry the "est." marker.
 */
export type DisplayQuantity = {
  text: string;
  derived: boolean;
  estimated: boolean;
};

/** Derived gram weight + estimate flag for a row, keyed by ingredient id. */
type GramInfo = { text: string; estimated: boolean };

/** Cooking quantities only — money/calories amounts belong to the table view. */
const isCookingQuantity = (a: WAmount): boolean =>
  !["money", "calories"].includes(wasm.amount_kind(a));

/**
 * True when the written amounts already carry a weight (e.g. "240 g"), so we
 * don't append the engine's derived grams on top and print "240 g / 240 g".
 */
const hasWrittenWeight = (ing: SectionIngredientOut): boolean =>
  ing.amounts.some((a) => wasm.amount_kind(a) === "weight");

/**
 * Ingredient id → derived gram weight, from the costing engine. The magazine
 * and spec views both surface these grams for lines whose written amount has no
 * weight of its own (e.g. "2 tsp ground ginger" → "3 g").
 */
export function gramMapFromCosting(
  costing: RecipeCosting | null,
): Map<string, GramInfo> {
  const map = new Map<string, GramInfo>();
  if (!costing) return map;
  for (const row of costing.rows) {
    const gram = row.priceInfo?.gram;
    if (gram?.isOk()) {
      map.set(row.id, {
        text: tryFormatAmount(gram.value),
        estimated: costing.estimatedRows.has(row.id),
      });
    }
  }
  return map;
}

/**
 * The full set of quantities to print for a row: its written cooking amounts,
 * plus the engine's derived grams when the line carries no weight of its own.
 */
export function buildDisplayQuantities(
  ing: SectionIngredientOut,
  gramById: Map<string, GramInfo>,
): DisplayQuantity[] {
  const written: DisplayQuantity[] = ing.amounts
    .filter(isCookingQuantity)
    .map((a) => ({
      // tryFormatAmount (not wasm.format_amount directly) so a persisted Amount's
      // camel `upperValue` is mapped to the WASM's snake `upper_value` and ranges
      // render ("1 - 2 tsp"). format_amount alone would drop the bound.
      text: tryFormatAmount(a),
      derived: false,
      estimated: false,
    }));
  const derivedGram = hasWrittenWeight(ing) ? undefined : gramById.get(ing.id);
  if (derivedGram) {
    written.push({
      text: derivedGram.text,
      derived: true,
      estimated: derivedGram.estimated,
    });
  }
  return written;
}

/** Dim italic prep note shown inline after an ingredient name (e.g.
 * "butter, softened"). Renders nothing when there's no modifier. */
export function IngredientModifier({
  modifier,
  className,
}: {
  modifier: string | null | undefined;
  className?: string;
}) {
  if (!modifier) return null;
  return (
    <span className={cn("text-muted-foreground/80 italic", className)}>
      , {modifier}
    </span>
  );
}

/** The single source of truth for the quantity gutter width + wrap behavior. */
export const ingredientRowGrid =
  "grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-2";
/** Narrower variant for the cramped live-preview panel (uses text-2xs). */
export const ingredientRowGridNarrow =
  "grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2";

/**
 * The mono quantity gutter: right-aligned amounts joined by " / ", derived
 * grams muted, "est." markers inline. Wraps within its column (no nowrap) so a
 * long dual amount like "1½ cups / 302 g" never overflows onto the name.
 */
export function IngredientQuantities({
  quantities,
  className,
  emptyText,
}: {
  quantities: DisplayQuantity[];
  /** Per-view text size / struck-opacity, e.g. "text-xs" or "text-2xs". */
  className?: string;
  /** Shown when there are no quantities (the spec table passes "—"). */
  emptyText?: string;
}) {
  return (
    <span
      className={cn(
        "text-right font-mono text-muted-foreground tabular-nums",
        className,
      )}
    >
      {quantities.length === 0
        ? (emptyText ?? null)
        : quantities.map((q, index) => (
            <span key={`${q.text}-${q.derived}-${q.estimated}`}>
              {index > 0 && " / "}
              <span
                className={q.derived ? "text-muted-foreground/70" : undefined}
              >
                {q.text}
                {q.estimated && <EstimateMarker />}
              </span>
            </span>
          ))}
    </span>
  );
}
