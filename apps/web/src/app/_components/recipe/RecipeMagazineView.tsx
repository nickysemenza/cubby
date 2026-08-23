import type { RecipeOut } from "@cubby/schemas/recipe";
import { sumBy } from "es-toolkit";
import { Eye, EyeOff } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { Eyebrow } from "~/components/ui/eyebrow";
import { sectionRuleClass } from "~/components/ui/section-rule";
import { costPerNutrient, proteinPer100Kcal } from "~/lib/nutrition-intel";
import type {
  CalculateTotalsResult,
  RecipeCosting,
} from "~/lib/recipe-costing";
import { cn, formatCurrency } from "~/lib/utils";
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
  type RecipeMacroStats,
  recipeMacroStats,
} from "./recipe-utils";
import { SectionHeading } from "./section-heading";

// Macro split for the vitals card: each macro's color (warm chart ramp) + its
// calorie density, so the proportion bar is weighted by energy contribution.
const MACRO_DEFS = [
  { key: "protein", label: "Protein", color: "var(--chart-1)", kcalPerG: 4 },
  { key: "fat", label: "Fat", color: "var(--chart-3)", kcalPerG: 9 },
  { key: "carbs", label: "Carbs", color: "var(--chart-5)", kcalPerG: 4 },
] as const;

/** The Read view's cost + macro card: a cost/calorie headline, an energy-
 * weighted macro proportion bar, and the P/F/C grams. Toggled by the reader. */
function VitalsPanel({
  stats,
  show,
  onToggle,
}: {
  stats: RecipeMacroStats;
  show: boolean;
  onToggle: () => void;
}) {
  const macros = MACRO_DEFS.map((m) => ({
    label: m.label,
    color: m.color,
    grams: stats[m.key] ?? 0,
    kcal: (stats[m.key] ?? 0) * m.kcalPerG,
  })).filter((m) => m.grams > 0);
  const macroKcal = sumBy(macros, (m) => m.kcal);

  // Two small nutrient-density figures, re-expressed from the same cost/kcal/
  // protein numbers already shown above — no new engine call, just division
  // (see nutrition-intel.ts). Null-safe: a recipe missing protein or calorie
  // data just omits these rather than showing a bogus ratio.
  const proteinDensity = proteinPer100Kcal(stats.protein, stats.kcal);
  const costPerProteinGram = costPerNutrient(stats.cost, stats.protein);

  return (
    <aside className="w-full lg:w-[230px] lg:self-start lg:justify-self-end">
      {show ? (
        <div className="border border-[var(--border)] bg-card p-4">
          <Row align="center" justify="between" className="mb-2">
            <span className="eyebrow">{stats.basisLabel}</span>
            <button
              type="button"
              onClick={onToggle}
              title="Hide nutrition & cost"
              className="text-muted-foreground hover:text-foreground"
            >
              <EyeOff className="size-3.5" />
            </button>
          </Row>

          {(stats.cost != null || stats.kcal != null) && (
            <Row align="baseline" justify="between" className="mb-2">
              {stats.cost != null && (
                <span className="font-heading font-semibold text-2xl tracking-tight">
                  {formatCurrency(stats.cost)}
                </span>
              )}
              {stats.kcal != null && (
                <span className="font-mono text-muted-foreground text-sm tabular-nums">
                  {Math.round(stats.kcal)}
                  <span className="ml-1 text-2xs uppercase tracking-wide">
                    kcal
                  </span>
                </span>
              )}
            </Row>
          )}

          {macros.length > 0 && macroKcal > 0 && (
            <>
              <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                {macros.map((m) => (
                  <div
                    key={m.label}
                    style={{
                      width: `${(m.kcal / macroKcal) * 100}%`,
                      backgroundColor: m.color,
                    }}
                  />
                ))}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1 text-center">
                {macros.map((m) => (
                  <div key={m.label}>
                    <div className="font-mono text-sm tabular-nums">
                      {Math.round(m.grams)}g
                    </div>
                    <div className="flex items-center justify-center gap-1 text-2xs text-muted-foreground uppercase tracking-wide">
                      <span
                        className="inline-block size-1.5 rounded-full"
                        style={{ backgroundColor: m.color }}
                      />
                      {m.label}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {(proteinDensity != null || costPerProteinGram != null) && (
            <Row
              align="center"
              justify="between"
              gap="sm"
              className="mt-2 border-border/60 border-t pt-2 text-2xs text-muted-foreground"
            >
              {proteinDensity != null && (
                <span>{proteinDensity.toFixed(1)}g protein / 100 kcal</span>
              )}
              {costPerProteinGram != null && (
                <span>{formatCurrency(costPerProteinGram)} / g protein</span>
              )}
            </Row>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
        >
          <Eye className="size-3.5" />
          Show nutrition &amp; cost
        </button>
      )}
    </aside>
  );
}

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
                  ? {
                      entity: "ingredient" as const,
                      id: ing.ingredient.id,
                    }
                  : ing.type === "recipe"
                    ? {
                        entity: "recipe" as const,
                        id: ing.recipe.id,
                      }
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
                        displayImage={null}
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

  // Makes/Serves on the eyebrow; the cost + macro split (the macro atom — per
  // serving when there's a basis, else total) lives in a toggleable vitals card
  // to the right of the headnote, so the reader can hide the numbers.
  const kicker = buildRecipeKicker({ yield: recipe.yield, servings }).join(
    "  ·  ",
  );
  const stats = totals ? recipeMacroStats(totals, basis) : null;
  const hasStats =
    !!stats &&
    (stats.cost != null ||
      stats.kcal != null ||
      stats.protein != null ||
      stats.fat != null ||
      stats.carbs != null);
  const [showVitals, setShowVitals] = useState(true);

  return (
    <Stack gap="lg">
      <RecipeHero recipe={recipe} />

      {kicker && (
        <Eyebrow className="border-foreground border-b pb-2 tracking-[0.12em]">
          {kicker}
        </Eyebrow>
      )}

      {/* Headnote (left) + a toggleable cost/macro card (right) — the card
          fills the rail beside the prose instead of leaving dead space. */}
      {(recipe.notes || hasStats) && (
        <div className="grid gap-6 lg:grid-cols-[1fr_230px] lg:gap-12">
          <div>
            {recipe.notes && (
              <MarkdownText className="max-w-prose text-muted-foreground">
                {recipe.notes}
              </MarkdownText>
            )}
          </div>
          {hasStats && stats && (
            <VitalsPanel
              stats={stats}
              show={showVitals}
              onToggle={() => setShowVitals((v) => !v)}
            />
          )}
        </div>
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
