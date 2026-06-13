import type {
  RecipeOut,
  RecipeSource,
  SectionIngredientOut,
} from "@cubby/schemas/recipe";
import { Fragment, useMemo, useState } from "react";
import { match, P } from "ts-pattern";
import { MarkdownText } from "~/components/markdown";
import type {
  CalculateTotalsResult,
  RecipeCosting,
} from "~/lib/recipe-costing";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { tryFormatAmount } from "../inventory/format-amount";
import { EstimateMarker } from "./estimate-marker";
import {
  computeScalingPercentages,
  formatScalingPct,
  pickDefaultBaseRowId,
} from "./recipe-scaling-pct";
import { formatYield, getIngredientName } from "./recipe-utils";

interface RecipeSpecViewProps {
  /** Already-scaled recipe (RecipeDetail multiplies amounts upstream). */
  recipe: RecipeOut;
  totals: CalculateTotalsResult | null;
  /** Per-row engine result — null while loading; grams/scaling degrade to "—". */
  costing: RecipeCosting | null;
}

/** Derived gram weight + estimate flag for a row, keyed by ingredient id. */
type GramInfo = { text: string; estimated: boolean };

/** Cooking quantities only — money/calories live in the table view. */
function writtenQuantities(ing: SectionIngredientOut): string[] {
  return ing.amounts
    .filter((a) => !["money", "calories"].includes(wasm.amount_kind(a)))
    .map((a) => wasm.format_amount(a));
}

/** True when the line already carries a weight, so we don't append derived grams. */
function hasWrittenWeight(ing: SectionIngredientOut): boolean {
  return ing.amounts.some((a) => wasm.amount_kind(a) === "weight");
}

/** A short italic attribution from the recipe's source, MC's footer line. */
function sourceFootnote(
  source: RecipeSource | null | undefined,
): string | null {
  if (!source) return null;
  return match(source)
    .with({ type: "book" }, (s) => `(from ${s.book})`)
    .with({ type: P.union("website", "notion") }, (s) => {
      try {
        return `(via ${new URL(s.url).hostname.replace(/^www\./, "")})`;
      } catch {
        return null;
      }
    })
    .otherwise(() => null);
}

export function RecipeSpecView({
  recipe,
  totals,
  costing,
}: RecipeSpecViewProps) {
  // Ingredient id → derived grams, from the same engine the other views use.
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
          <tr className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
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
                    <td
                      colSpan={4}
                      className="pt-3 pb-1 font-mono text-2xs text-eyebrow uppercase tracking-wider"
                    >
                      {section.name}
                    </td>
                  </tr>
                )}

                {ingredients.map((ing, ri) => {
                  const name = getIngredientName(ing);
                  const derivedGram = hasWrittenWeight(ing)
                    ? undefined
                    : gramById.get(ing.id);
                  const quantities = [
                    ...writtenQuantities(ing).map((text) => ({
                      text,
                      derived: false,
                      estimated: false,
                    })),
                    ...(derivedGram
                      ? [
                          {
                            text: derivedGram.text,
                            derived: true,
                            estimated: derivedGram.estimated,
                          },
                        ]
                      : []),
                  ];

                  const pct = pctById.get(ing.id) ?? null;
                  const isBase = ing.id === baseId;

                  return (
                    <tr key={ing.id} className="align-top">
                      <td className="py-1.5 pr-3 font-medium text-sm leading-snug">
                        {name}
                        {isBase && (
                          <span className="ml-1.5 rounded-sm bg-primary/10 px-1 py-px align-middle font-mono text-[9px] text-primary uppercase tracking-wide">
                            100% base
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-muted-foreground text-xs tabular-nums">
                        {quantities.length > 0
                          ? quantities.map((q, qi) => (
                              <span
                                key={`${q.text}-${qi}`}
                                className={
                                  q.derived
                                    ? "text-muted-foreground/70"
                                    : undefined
                                }
                              >
                                {qi > 0 && " / "}
                                {q.text}
                                {q.estimated && <EstimateMarker />}
                              </span>
                            ))
                          : "—"}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs tabular-nums">
                        {pct == null ? (
                          <span className="text-muted-foreground/60">—</span>
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
          Scaling omits {totals.missingByType.weight.length} ingredient
          {totals.missingByType.weight.length === 1 ? "" : "s"} without a
          weight.
        </p>
      )}
    </div>
  );
}
