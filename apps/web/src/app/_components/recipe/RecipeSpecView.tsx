import type { RecipeOut } from "@cubby/schemas/recipe";
import { uniq } from "es-toolkit";
import { Fragment, useMemo, useState } from "react";
import { MarkdownText } from "~/components/markdown";
import type {
  CalculateTotalsResult,
  RecipeCosting,
} from "~/lib/recipe-costing";
import { cn } from "~/lib/utils";
import {
  buildDisplayQuantities,
  gramMapFromCosting,
  IngredientModifier,
  IngredientQuantities,
} from "./IngredientQuantities";
import {
  computeScalingPercentages,
  formatScalingPct,
  pickDefaultBaseRowId,
} from "./recipe-scaling-pct";
import { sourceFootnote } from "./recipe-source";
import { formatYield, getIngredientName } from "./recipe-utils";

interface RecipeSpecViewProps {
  /** Already-scaled recipe (RecipeDetail multiplies amounts upstream). */
  recipe: RecipeOut;
  totals: CalculateTotalsResult | null;
  /** Per-row engine result — null while loading; grams/scaling degrade to "—". */
  costing: RecipeCosting | null;
}

export function RecipeSpecView({
  recipe,
  totals,
  costing,
}: RecipeSpecViewProps) {
  // Ingredient id → derived grams, from the same engine the other views use.
  const gramById = useMemo(() => gramMapFromCosting(costing), [costing]);

  // Scaling base (the 100% reference). Defaults to flour, else the heaviest row;
  // clicking any row's % re-anchors it — purely client-side, no engine re-call.
  const defaultBaseId = useMemo(
    () => (costing ? pickDefaultBaseRowId(costing) : null),
    [costing],
  );
  const [pickedBaseId, setPickedBaseId] = useState<string | null>(null);
  const baseId = pickedBaseId ?? defaultBaseId;

  const pctById = useMemo(
    () => (costing ? computeScalingPercentages(costing, baseId) : new Map()),
    [costing, baseId],
  );

  // Sections become red-ruled row groups; steps number continuously across them.
  const sectionBlocks = useMemo(() => {
    let n = 0;
    return recipe.sections.map((section) => ({
      section,
      steps: section.instructions.map((ins) => ({
        n: ++n,
        text: ins.instruction,
      })),
    }));
  }, [recipe.sections]);

  const showSectionNames = recipe.sections.length > 1;
  const footnote = sourceFootnote(recipe.source);

  const renderSteps = (steps: { n: number; text: string }[]) => (
    <div className="space-y-2">
      {steps.map((step) => (
        <div key={step.n} className="flex gap-2.5">
          <span className="mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-border-chunky font-mono text-[10px] text-muted-foreground tabular-nums">
            {step.n}
          </span>
          <span className="text-foreground/85 text-sm leading-snug">
            <MarkdownText className="[&_p]:my-0">{step.text}</MarkdownText>
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="rounded-xl border border-border-chunky bg-card px-6 py-6 sm:px-8">
      {/* Title + yield */}
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="my-0 font-heading font-semibold text-2xl tracking-tight">
          {recipe.name}
        </h2>
        {recipe.yield?.value ? (
          <span className="font-heading text-primary text-sm">
            Yields {formatYield(recipe.yield)}
          </span>
        ) : null}
      </header>

      {/* Headnote + tips */}
      {recipe.notes && (
        <MarkdownText className="mb-5 max-w-prose text-muted-foreground">
          {recipe.notes}
        </MarkdownText>
      )}

      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="eyebrow">
            <th className="pr-3 pb-2 font-medium">Ingredient</th>
            <th className="pr-3 pb-2 font-medium">Quantity</th>
            <th className="pr-3 pb-2 font-medium">Scaling</th>
            <th className="pb-2 font-medium">Procedure</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={4} className="border-primary border-t-2" />
          </tr>

          {sectionBlocks.map(({ section, steps }, si) => {
            const ingredients = section.ingredients;
            const procedureCell = (
              <td
                rowSpan={Math.max(1, ingredients.length)}
                className="py-2 pl-3 align-top"
              >
                {renderSteps(steps)}
              </td>
            );

            return (
              <Fragment key={section.id}>
                {si > 0 && (
                  <tr>
                    <td colSpan={4} className="border-primary border-t" />
                  </tr>
                )}
                {showSectionNames && section.name && (
                  <tr>
                    <td colSpan={4} className="eyebrow pt-3 pb-1">
                      {section.name}
                    </td>
                  </tr>
                )}

                {ingredients.map((ing, ri) => {
                  const name = getIngredientName(ing);
                  const quantities = buildDisplayQuantities(ing, gramById);

                  const pct = pctById.get(ing.id) ?? null;
                  const isBase = ing.id === baseId;
                  // No resolvable weight → this row can't scale (same signal that
                  // feeds totals.missingByType.weight). Flag it loudly.
                  const noWeight = !gramById.has(ing.id);

                  return (
                    <tr key={ing.id} className="align-top">
                      <td className="py-1.5 pr-3 font-medium text-sm leading-snug">
                        {name}
                        <IngredientModifier modifier={ing.modifier} />
                        {isBase && (
                          <span className="ml-1.5 rounded-sm bg-primary/10 px-1 py-px align-middle font-mono text-[9px] text-primary uppercase tracking-wide">
                            100% base
                          </span>
                        )}
                        {noWeight && (
                          <span
                            title="No weight — omitted from scaling"
                            className="ml-1.5 rounded-sm bg-warning/15 px-1 py-px align-middle font-mono text-[9px] text-warning uppercase tracking-wide"
                          >
                            no weight
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        <IngredientQuantities
                          quantities={quantities}
                          className="text-xs"
                          emptyText="—"
                        />
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs tabular-nums">
                        {pct == null ? (
                          <span
                            title={
                              noWeight
                                ? "No weight — omitted from scaling"
                                : undefined
                            }
                            className={cn(
                              noWeight
                                ? "text-warning/80"
                                : "text-muted-foreground/60",
                            )}
                          >
                            —
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPickedBaseId(ing.id)}
                            aria-pressed={isBase}
                            title="Set as 100% base"
                            className={cn(
                              "cursor-pointer rounded-sm hover:text-primary",
                              isBase
                                ? "font-medium text-primary"
                                : "text-foreground/80",
                            )}
                          >
                            {formatScalingPct(pct)}
                          </button>
                        )}
                      </td>
                      {ri === 0 && procedureCell}
                    </tr>
                  );
                })}

                {ingredients.length === 0 && (
                  <tr className="align-top">
                    <td colSpan={3} />
                    {procedureCell}
                  </tr>
                )}
              </Fragment>
            );
          })}

          <tr>
            <td colSpan={4} className="border-primary border-t-2" />
          </tr>
        </tbody>
      </table>

      {/* Attribution footer */}
      {footnote && (
        <p className="mt-3 font-heading text-primary text-xs italic">
          {footnote}
        </p>
      )}

      {/* Keep the totals reference wired even when the kicker is omitted, so the
          spec sheet stays consistent with the costing the other views show. */}
      {totals && totals.missingByType.weight.length > 0 && (
        <p className="mt-2 font-mono text-2xs text-muted-foreground/70">
          Scaling omits{" "}
          <span className="text-warning">
            {uniq(totals.missingByType.weight).join(", ")}
          </span>{" "}
          — no weight.
        </p>
      )}
    </div>
  );
}
