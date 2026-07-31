import type { Amount } from "@cubby/schemas/codec";
import type {
  CandidateEquivalence,
  EquivalenceExample,
} from "@cubby/schemas/equivalences";
import type {
  IngredientId,
  IngredientShortcode,
  RecipeId,
  RecipeShortcode,
} from "@cubby/schemas/identifiers";
import { groupBy, median } from "es-toolkit";

// One recipe-ingredient occurrence with its parsed measures. Matches the repo's
// `getMultiMeasureRecipeIngredients` select; declared here so the pure
// aggregation has no `~/server` runtime import (testable in the node project).
export interface HarvestRow {
  ingredientId: IngredientId;
  ingredientShortcode: IngredientShortcode;
  ingredientName: string;
  recipeId: RecipeId;
  recipeShortcode: RecipeShortcode;
  recipeName: string;
  rawLine: string | null;
  amounts: Amount[];
}

// Injected unit logic — the router wires these to WASM (`amount_kind` /
// `conv_amount_to_kind`), so this module imports no WASM and the unit test can
// stub them. `kindOf` classifies a unit's dimension ("weight"/"volume"/"money"/
// "other:<unit>"/…). `convert` re-expresses a value in another unit OF THE SAME
// KIND (e.g. oz→g, tbsp→cup), returning null when there's no path; cross-kind
// conversion (the thing we're harvesting) is never asked of it.
export interface UnitTools {
  kindOf: (a: { value: number; unit: string }) => string;
  convert: (value: number, fromUnit: string, toUnit: string) => number | null;
}

// Canonical display unit per standard dimension. A pair is grouped + shown in
// these (so cup↔g, cup↔oz, tbsp↔g all collapse into one "1 cup ≈ N g" density
// row rather than near-duplicate rows differing only by which weight/volume unit
// the recipe happened to use). Dimensions not listed (count/"other", money,
// nutrient, …) are treated as their own island — kept as the literal unit, since
// "1 large egg" can't be re-expressed as another count.
const DISPLAY_UNIT: Record<string, string> = { weight: "g", volume: "cup" };

// Only these kinds are ingredient-quantity measures worth equating: weight,
// volume, and count/"other" islands (egg, bunch, can). Everything else a recipe
// line can carry — temperature ("350°F (175°C)"), length (pan "9\" (23 cm)"),
// time, money, calories, nutrients — is not a density/count fact, so drop it
// before pairing.
const isHarvestableKind = (kind: string): boolean =>
  kind === "weight" || kind === "volume" || kind.startsWith("other");

const MAX_EXAMPLES = 5;

// How a measure's dimension is keyed + displayed. Standard kinds (weight/volume)
// normalize to a canonical unit so their variants merge; everything else is an
// island keyed by its own unit (no within-kind merge, no conversion).
interface DimInfo {
  token: string; // grouping key for this side
  displayUnit: string; // unit the ratio is expressed in
  island: boolean; // true ⇒ not normalized (count/other/unhandled kind)
}

const dimInfo = (tools: UnitTools, m: Amount): DimInfo => {
  const kind = tools.kindOf(m);
  const display = DISPLAY_UNIT[kind];
  return display
    ? { token: kind, displayUnit: display, island: false }
    : { token: m.unit, displayUnit: m.unit, island: true };
};

interface FlatPair {
  ingredientId: IngredientId;
  ingredientShortcode: IngredientShortcode;
  ingredientName: string;
  recipeId: RecipeId;
  recipeShortcode: RecipeShortcode;
  recipeName: string;
  rawLine: string | null;
  tokenA: string;
  tokenB: string;
  unitA: string; // display unit for side a
  unitB: string; // display unit for side b
  a: Amount; // original measures, oriented a↔unitA-side / b↔unitB-side
  b: Amount;
  ratio: number; // displayUnitB per 1 displayUnitA
}

/**
 * Harvest ingredient-scoped unit equivalences from recipe lines that carry a
 * secondary (parenthetical) measure. For every cross-dimension measure pair, emit
 * a candidate; group by (ingredient, dimension pair) and aggregate occurrences,
 * the median ratio, and its spread (the agreement signal). Pure + deterministic —
 * all unit logic comes through the injected {@link UnitTools}.
 *
 * Grouping is by DIMENSION, not raw units: a side in a standard kind (weight,
 * volume) is normalized to one canonical display unit (g, cup) so "1 cup ≈ 200 g"
 * and "1 cup ≈ 7 oz" — the same density in different weight units — collapse into
 * a single row. Count/"other" units (egg, bunch, can) stay their own island.
 *
 * Orientation (deterministic, for readable labels): when exactly one side is an
 * island it becomes the `1 X` denominator ("1 large ≈ 50 g", "1 bunch ≈ 5 cup");
 * otherwise the two dimension tokens sort lexicographically (volume before weight
 * ⇒ "1 cup ≈ 200 g"). `ratio` is always `unitB` per 1 `unitA`.
 */
export const harvestEquivalences = (
  rows: HarvestRow[],
  tools: UnitTools,
): CandidateEquivalence[] => {
  const pairs: FlatPair[] = [];

  for (const row of rows) {
    // Collapse to one usable measure per dimension token (keep the first) so a
    // line like "5 oz (¾ cup; 140 g)" — two weight measures — contributes one
    // volume↔weight observation, not a self-corroborating double count.
    const byToken = new Map<string, { m: Amount; info: DimInfo }>();
    for (const m of row.amounts) {
      if (!(m.value > 0) || !Number.isFinite(m.value)) continue;
      if (!isHarvestableKind(tools.kindOf(m))) continue;
      const info = dimInfo(tools, m);
      if (!byToken.has(info.token)) byToken.set(info.token, { m, info });
    }
    const measures = [...byToken.values()];

    for (let i = 0; i < measures.length; i++) {
      for (let j = i + 1; j < measures.length; j++) {
        const x = measures[i]!;
        const y = measures[j]!;
        // Distinct dimension tokens ⇒ cross-dimension (the engine can't already
        // convert it). Same-kind pairs were collapsed above.

        // Orient: the island side (count/other) leads when there's exactly one;
        // otherwise the smaller dimension token leads (volume < weight).
        const aFirst =
          x.info.island !== y.info.island
            ? x.info.island
            : x.info.token < y.info.token;
        const [a, b] = aFirst ? [x, y] : [y, x];

        // Express each side in its display unit. Island sides are identity; the
        // others convert within-kind (tbsp→cup, oz→g). Skip if either fails.
        const aVal = a.info.island
          ? a.m.value
          : tools.convert(a.m.value, a.m.unit, a.info.displayUnit);
        const bVal = b.info.island
          ? b.m.value
          : tools.convert(b.m.value, b.m.unit, b.info.displayUnit);
        if (aVal == null || bVal == null || !(aVal > 0)) continue;

        pairs.push({
          ingredientId: row.ingredientId,
          ingredientShortcode: row.ingredientShortcode,
          ingredientName: row.ingredientName,
          recipeId: row.recipeId,
          recipeShortcode: row.recipeShortcode,
          recipeName: row.recipeName,
          rawLine: row.rawLine,
          tokenA: a.info.token,
          tokenB: b.info.token,
          unitA: a.info.displayUnit,
          unitB: b.info.displayUnit,
          a: a.m,
          b: b.m,
          ratio: bVal / aVal,
        });
      }
    }
  }

  const grouped = groupBy(
    pairs,
    (p) => `${p.ingredientId} ${p.tokenA} ${p.tokenB}`,
  );

  const candidates: CandidateEquivalence[] = Object.values(grouped).map(
    (group): CandidateEquivalence => {
      // group is non-empty (it's a groupBy bucket).
      const first = group[0]!;
      const ratios = group.map((p) => p.ratio);
      const examples: EquivalenceExample[] = group
        .slice(0, MAX_EXAMPLES)
        .map((p) => ({
          recipeId: p.recipeId,
          recipeShortcode: p.recipeShortcode,
          recipeName: p.recipeName,
          rawLine: p.rawLine,
          a: p.a,
          b: p.b,
        }));
      return {
        ingredientId: first.ingredientId,
        ingredientShortcode: first.ingredientShortcode,
        ingredientName: first.ingredientName,
        unitA: first.unitA,
        unitB: first.unitB,
        occurrences: group.length,
        medianRatio: median(ratios),
        ratioSpread: { min: Math.min(...ratios), max: Math.max(...ratios) },
        examples,
      };
    },
  );

  // Confidence-first: most-corroborated candidates, then tightest agreement
  // (spread closest to 1×), then a stable name/unit tiebreak.
  const spreadFactor = (c: CandidateEquivalence): number =>
    c.ratioSpread.min > 0 ? c.ratioSpread.max / c.ratioSpread.min : Infinity;
  return candidates.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      spreadFactor(a) - spreadFactor(b) ||
      a.ingredientName.localeCompare(b.ingredientName) ||
      a.unitA.localeCompare(b.unitA) ||
      a.unitB.localeCompare(b.unitB),
  );
};
