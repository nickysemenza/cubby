import type { RecipeOut } from "@cubby/schemas/recipe";
import { type ReactNode, useMemo, useState } from "react";
import { Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { Eyebrow } from "~/components/ui/eyebrow";
import { sectionRuleClass } from "~/components/ui/section-rule";
import type {
  CalculateTotalsResult,
  RecipeCosting,
} from "~/lib/recipe-costing";
import { cn } from "~/lib/utils";
import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import {
  buildDisplayQuantities,
  gramMapFromCosting,
  IngredientModifier,
  IngredientQuantities,
  ingredientRowGrid,
} from "./IngredientQuantities";
import { RecipeHero } from "./RecipeHero";
import { RecipeInstructions } from "./RecipeInstructions";
import {
  buildRecipeKicker,
  getEffectiveServings,
  getIngredientName,
  getServingBasis,
  recipeMacroSegments,
} from "./recipe-utils";
import { SectionHeading } from "./section-heading";

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

/** Broadsheet section heading: heavy top rule + serif title. */
function SpreadHeading({ children }: { children: ReactNode }) {
  return (
    <div className={sectionRuleClass}>
      <h3 className="my-0 font-bold font-heading text-base">{children}</h3>
    </div>
  );
}

/**
 * Ingredient ledger: mono quantity gutter + name, dashed rules, click a row
 * to strike it off while cooking. The source's raw line lives in the tooltip.
 */
function IngredientLedger({
  recipe,
  gramById,
}: {
  recipe: RecipeOut;
  gramById: ReturnType<typeof gramMapFromCosting>;
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
    <Stack gap="md">
      {recipe.sections.map((section, sectionIndex) => (
        <div key={section.id}>
          <SectionHeading
            sectionName={section.name}
            index={sectionIndex}
            total={recipe.sections.length}
            className="mb-1"
          />
          <ul className="my-0 ml-0 list-none divide-y divide-dashed divide-border">
            {section.ingredients.map((ing) => {
              const name = getIngredientName(ing);
              const isStruck = struck.has(ing.id);
              const quantities = buildDisplayQuantities(ing, gramById);
              // Strike-off lives on the quantity gutter (a button), so the name
              // can be a dotted popover-link — hover for the entity preview,
              // click to open it — without the two interactions colliding.
              const ref =
                ing.type === "ingredient"
                  ? { entity: "ingredient" as const, id: ing.ingredient.id }
                  : ing.type === "recipe"
                    ? { entity: "recipe" as const, id: ing.recipe.id }
                    : null;
              return (
                <li key={ing.id} className={cn(ingredientRowGrid, "py-2")}>
                  <button
                    type="button"
                    aria-pressed={isStruck}
                    onClick={() => toggle(ing.id)}
                    title={
                      ing.rawLine && ing.rawLine !== name
                        ? ing.rawLine
                        : "Cross off"
                    }
                    className="cursor-pointer text-left"
                  >
                    <IngredientQuantities
                      quantities={quantities}
                      className={cn("text-xs", isStruck && "opacity-40")}
                    />
                  </button>
                  <span
                    className={cn(
                      "text-sm leading-snug",
                      isStruck && "text-muted-foreground line-through",
                    )}
                  >
                    {ref ? (
                      <EntityPreviewLink
                        entity={ref.entity}
                        id={ref.id}
                        className={dottedEntityLink}
                      >
                        {name}
                      </EntityPreviewLink>
                    ) : (
                      name
                    )}
                    <IngredientModifier modifier={ing.modifier} />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Stack>
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

  // Ingredient id → derived gram weight, from the same engine the table uses.
  const gramById = useMemo(() => gramMapFromCosting(costing), [costing]);

  // Vitals (Makes/Serves) on the eyebrow; the cost + macro split rides on its own
  // mono line just below (the macro atom — per-serving when there's a basis, else
  // total — so the reader sees $·kcal·P·F·C without a hand-typed headnote).
  const kicker = buildRecipeKicker({ yield: recipe.yield, servings }).join(
    "  ·  ",
  );
  const macro = totals ? recipeMacroSegments(totals, basis) : null;

  return (
    <Stack gap="lg">
      {/* Hero Section */}
      <RecipeHero recipe={recipe} />

      {/* Kicker: the recipe's vitals + a cost/macro line */}
      {(kicker || (macro && macro.parts.length > 0)) && (
        <div className="border-foreground border-b pb-2">
          {kicker && <Eyebrow className="tracking-[0.12em]">{kicker}</Eyebrow>}
          {macro && macro.parts.length > 0 && (
            <div className="mt-1 font-mono text-muted-foreground text-xs">
              <span className="uppercase tracking-wide">
                {macro.basisLabel}
              </span>{" "}
              · {macro.parts.join("  ·  ")}
            </div>
          )}
        </div>
      )}

      {/* Headnote + tips: freeform markdown imported from the source or edited */}
      {recipe.notes && (
        <MarkdownText className="max-w-prose text-muted-foreground">
          {recipe.notes}
        </MarkdownText>
      )}

      {/* Open-book spread: ingredients column + method column, no boxes */}
      <div className="grid gap-6 lg:grid-cols-[300px_1fr] lg:gap-12">
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
    </Stack>
  );
}
