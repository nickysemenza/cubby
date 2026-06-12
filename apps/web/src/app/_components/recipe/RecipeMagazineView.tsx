import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import { type ReactNode, useMemo, useState } from "react";
import { MarkdownText } from "~/components/markdown";
import { sectionRuleClass } from "~/components/ui/section-rule";
import type {
  CalculateTotalsResult,
  RecipeCosting,
} from "~/lib/recipe-costing";
import { cn, formatCurrency } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { tryFormatAmount } from "../inventory/format-amount";
import { RecipeHero } from "./RecipeHero";
import { RecipeInstructions } from "./RecipeInstructions";
import {
  formatYield,
  getEffectiveServings,
  getIngredientName,
  getServingBasis,
  perUnitSuffix,
  recipeHeadlineTotals,
} from "./recipe-utils";

interface RecipeMagazineViewProps {
  recipe: RecipeOut;
  /** Costing rollup — null while loading; the kicker degrades gracefully. */
  totals: CalculateTotalsResult | null;
  /**
   * Per-ingredient engine result — null while loading. Supplies the derived
   * gram weight for ingredients whose written amount carries no weight (e.g.
   * "2 tsp ground ginger" → "3 g"), so the ledger matches the table view.
   */
  costing: RecipeCosting | null;
}

/** Derived gram weight for a single ingredient row, keyed by ingredient id. */
type GramInfo = { text: string; estimated: boolean };

/** Broadsheet section heading: heavy top rule + serif title. */
function SpreadHeading({ children }: { children: ReactNode }) {
  return (
    <div className={sectionRuleClass}>
      <h3 className="my-0 font-bold font-heading text-base">{children}</h3>
    </div>
  );
}

/** Cooking quantities only — money/calories amounts belong to the table view. */
function formatWrittenQuantities(ing: SectionIngredientOut) {
  return ing.amounts
    .filter((a) => !["money", "calories"].includes(wasm.amount_kind(a)))
    .map((a, index) => ({
      key: `written-${index}-${a.value}-${a.unit}`,
      text: wasm.format_amount(a),
      derived: false,
      estimated: false,
    }));
}

/**
 * True when the written amounts already carry a weight (e.g. "240 g"), so we
 * don't append the engine's derived grams on top and print "240 g / 240 g".
 */
function hasWrittenWeight(ing: SectionIngredientOut): boolean {
  return ing.amounts.some((a) => wasm.amount_kind(a) === "weight");
}

/** Muted "est." tag mirroring the table — keeps modeled grams from reading as measured. */
const EstimateMarker = () => (
  <span className="ml-1 text-[0.9em] text-muted-foreground/70">est.</span>
);

/**
 * Ingredient ledger: mono quantity gutter + name, dashed rules, click a row
 * to strike it off while cooking. The source's raw line lives in the tooltip.
 */
function IngredientLedger({
  recipe,
  gramById,
}: {
  recipe: RecipeOut;
  gramById: Map<string, GramInfo>;
}) {
  const [struck, setStruck] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setStruck((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {recipe.sections.map((section, sectionIndex) => (
        <div key={section.id}>
          {(recipe.sections.length > 1 || section.name) && (
            <p className="mb-1 font-mono text-2xs text-eyebrow uppercase tracking-wider">
              {section.name || `Part ${sectionIndex + 1}`}
            </p>
          )}
          <ul className="my-0 ml-0 list-none divide-y divide-dashed divide-border">
            {section.ingredients.map((ing) => {
              const name = getIngredientName(ing);
              const isStruck = struck.has(ing.id);
              // Append the engine's derived grams only when the line has no
              // written weight of its own, so we never double up ("240 g / 240 g").
              const derivedGram = hasWrittenWeight(ing)
                ? undefined
                : gramById.get(ing.id);
              const quantities = [
                ...formatWrittenQuantities(ing),
                ...(derivedGram
                  ? [
                      {
                        key: "derived-grams",
                        text: derivedGram.text,
                        derived: true,
                        estimated: derivedGram.estimated,
                      },
                    ]
                  : []),
              ];
              return (
                <li key={ing.id}>
                  <button
                    type="button"
                    aria-pressed={isStruck}
                    onClick={() => toggle(ing.id)}
                    title={
                      ing.rawLine && ing.rawLine !== name
                        ? ing.rawLine
                        : undefined
                    }
                    className="grid w-full cursor-pointer grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-2 py-1.5 text-left"
                  >
                    <span
                      className={cn(
                        "whitespace-nowrap text-right font-mono text-muted-foreground text-xs tabular-nums",
                        isStruck && "opacity-40",
                      )}
                    >
                      {quantities.map((quantity, index) => (
                        <span key={quantity.key}>
                          {index > 0 && " / "}
                          <span
                            className={
                              quantity.derived
                                ? "text-muted-foreground/70"
                                : undefined
                            }
                          >
                            {quantity.text}
                            {quantity.estimated && <EstimateMarker />}
                          </span>
                        </span>
                      ))}
                    </span>
                    <span
                      className={cn(
                        "text-sm leading-snug",
                        isStruck && "text-muted-foreground line-through",
                      )}
                    >
                      {name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function RecipeMagazineView({
  recipe,
  totals,
  costing,
}: RecipeMagazineViewProps) {
  const servings = getEffectiveServings(recipe);
  // Per-portion basis: explicit servings, else the yield count labelled by unit
  // (e.g. "/ cup", "/ churro"); falls back to "each".
  const basis = getServingBasis(recipe);
  // The four headline figures (cost, weight, calories, protein), defined once.
  const head = totals ? recipeHeadlineTotals(totals) : null;

  // Ingredient id → derived gram weight, from the same engine the table uses.
  const gramById = useMemo(() => {
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
  }, [costing]);

  const kicker = [
    recipe.yield?.value ? `Makes ${formatYield(recipe.yield)}` : null,
    servings && recipe.yield?.unit !== "servings" ? `Serves ${servings}` : null,
    head?.cost && basis
      ? `${formatCurrency(head.cost / basis.divisor)} ${perUnitSuffix(basis.noun)}`
      : head?.cost
        ? `${formatCurrency(head.cost)} total`
        : null,
    head?.calories && basis
      ? `${Math.round(head.calories / basis.divisor)} kcal ${perUnitSuffix(basis.noun)}`
      : null,
    head?.protein && basis
      ? `${Math.round(head.protein / basis.divisor)}g protein ${perUnitSuffix(basis.noun)}`
      : null,
    head?.weight && basis
      ? `${Math.round(head.weight / basis.divisor)}g ${perUnitSuffix(basis.noun)}`
      : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <div className="space-y-6">
      {/* Hero Section */}
      <RecipeHero recipe={recipe} />

      {/* Kicker: the recipe's vitals on one ledger line */}
      {kicker && (
        <p className="border-foreground border-b pb-1.5 font-mono text-2xs text-eyebrow uppercase tracking-[0.12em]">
          {kicker}
        </p>
      )}

      {/* Headnote + tips: freeform markdown imported from the source or edited */}
      {recipe.notes && (
        <MarkdownText className="max-w-prose text-muted-foreground">
          {recipe.notes}
        </MarkdownText>
      )}

      {/* Open-book spread: ingredients column + method column, no boxes */}
      <div className="grid gap-8 lg:grid-cols-[300px_1fr] lg:gap-12">
        <aside className="lg:sticky lg:top-20 lg:h-fit">
          <SpreadHeading>Ingredients</SpreadHeading>
          <div className="mt-2">
            <IngredientLedger recipe={recipe} gramById={gramById} />
          </div>
        </aside>

        <main>
          <SpreadHeading>Method</SpreadHeading>
          <div className="mt-4">
            <RecipeInstructions recipe={recipe} />
          </div>
        </main>
      </div>
    </div>
  );
}
