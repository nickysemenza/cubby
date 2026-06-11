import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { type ReactNode, useState } from "react";
import { MarkdownText } from "~/components/markdown";
import { sectionRuleClass } from "~/components/ui/section-rule";
import type { CalculateTotalsResult } from "~/lib/recipe-costing";
import { cn, formatCurrency } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { RecipeHero } from "./RecipeHero";
import { RecipeInstructions } from "./RecipeInstructions";
import {
  formatYield,
  getEffectiveServings,
  getIngredientName,
} from "./recipe-utils";

interface RecipeMagazineViewProps {
  recipe: RecipeOut;
  /** Costing rollup — null while loading; the kicker degrades gracefully. */
  totals: CalculateTotalsResult | null;
}

/** Broadsheet section heading: heavy top rule + serif title. */
function SpreadHeading({ children }: { children: ReactNode }) {
  return (
    <div className={sectionRuleClass}>
      <h3 className="my-0 font-bold font-heading text-base">{children}</h3>
    </div>
  );
}

/** Cooking quantities only — money/calories amounts belong to the table view. */
function formatQty(ing: SectionIngredientOut): string {
  return ing.amounts
    .filter((a) => !["money", "calories"].includes(wasm.amount_kind(a)))
    .map((a) => wasm.format_amount(a))
    .join(" / ");
}

/**
 * Ingredient ledger: mono quantity gutter + name, dashed rules, click a row
 * to strike it off while cooking. The source's raw line lives in the tooltip.
 */
function IngredientLedger({ recipe }: { recipe: RecipeOut }) {
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
                    className="grid w-full cursor-pointer grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-2 py-1.5 text-left"
                  >
                    <span
                      className={cn(
                        "text-right font-mono text-muted-foreground text-xs tabular-nums",
                        isStruck && "opacity-40",
                      )}
                    >
                      {formatQty(ing)}
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
}: RecipeMagazineViewProps) {
  const servings = getEffectiveServings(recipe);
  const kcal = totals ? getNutrientValueByKey(totals.nutrients, "kcal") : 0;

  const kicker = [
    recipe.yield?.value ? `Makes ${formatYield(recipe.yield)}` : null,
    servings && recipe.yield?.unit !== "servings" ? `Serves ${servings}` : null,
    totals?.price && servings
      ? `${formatCurrency(totals.price / servings)} / serving`
      : totals?.price
        ? `${formatCurrency(totals.price)} total`
        : null,
    kcal && servings ? `${Math.round(kcal / servings)} kcal / serving` : null,
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
            <IngredientLedger recipe={recipe} />
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
