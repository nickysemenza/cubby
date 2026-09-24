import { GridNineIcon as Grid3x3 } from "@phosphor-icons/react/dist/csr/GridNine";
import { ShoppingCartIcon as ShoppingCart } from "@phosphor-icons/react/dist/csr/ShoppingCart";
import { memo, useMemo, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { formatCurrencyRange } from "~/lib/format-range";
import { blockReasonText } from "~/lib/sub-recipe-reason";
import { formatCurrency } from "~/lib/utils";

import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import { IngredientComponentGrid } from "./IngredientComponentGrid";
import {
  buildDisplayQuantities,
  gramMapFromCosting,
  IngredientModifier,
  IngredientQuantities,
} from "./IngredientQuantities";
import {
  asUsedGramsByRecipe,
  batchYieldGrams,
  type CombinedNeed,
  flattenComponents,
  fullBatchCostByComponent,
  fullBatchNeeds,
  type RecipeTreeNode,
  type RecipeTreeRow,
  recipeTreeDisplayImage,
} from "./recipe-tree";
import {
  entityRefForRow,
  formatMakes,
  formatYield,
  getIngredientName,
  getServingBasis,
  gramText,
  recipeMacroSegments,
} from "./recipe-utils";
import { StepNumberBadge, StubWarning } from "./spec-markers";

// Prep sheet: the recipe broken into one block per component (every sub-recipe
// + the root assembly, dependencies first), each an actionable checklist with
// its steps. Components are shown at their FULL batch (clean authored amounts —
// you batch a sub-recipe, you don't make "0.16 of a chicken"); a per-component
// "X used" note + the top shopping list carry the as-used / UI-scaled totals.

function ShoppingList({
  needs,
  totalCost,
  totalCostUpper,
}: {
  needs: CombinedNeed[];
  totalCost: number | null;
  totalCostUpper: number | null;
}) {
  if (needs.length === 0) return null;
  return (
    <details className="border border-[var(--border)] bg-muted/30 px-4 py-2 print:border-0 print:bg-transparent print:px-0">
      <summary className="cursor-pointer eyebrow marker:content-none">
        <ShoppingCart className="mr-2 inline size-3 align-[-2px]" />
        Shopping list
        <span className="ml-1 text-muted-foreground">· full batch</span>
        {totalCost != null && (
          <span className="ml-1 text-foreground">
            · {formatCurrencyRange(totalCost, totalCostUpper ?? undefined)}
          </span>
        )}
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {needs.map((need) => (
          <Row
            align="baseline"
            justify="between"
            gap="sm"
            key={need.ingredientId}
            className="border-b border-dashed border-border/50 py-1"
          >
            <span className="truncate" title={need.name}>
              <EntityPreviewLink
                displayImage={null}
                entity="ingredient"
                id={need.ingredientShortcode}
                className={dottedEntityLink}
              >
                {need.name}
              </EntityPreviewLink>
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {need.grams != null ? gramText(need.grams) : "—"}
              {need.estimated && <span className="text-warning"> ~</span>}
            </span>
          </Row>
        ))}
      </div>
    </details>
  );
}

function PrepRow({
  row,
  gramById,
}: {
  row: RecipeTreeRow;
  gramById: Map<string, { text: string; estimated: boolean }>;
}) {
  if (row.kind === "stub") {
    return (
      <Row
        align="baseline"
        gap="sm"
        className="border-b border-dashed border-border/60 py-2"
      >
        <span className="size-3.5 shrink-0" />
        <span className="flex-1 text-sm text-muted-foreground italic">
          {row.name}{" "}
          <StubWarning>
            {row.reason === "cycle" ? "↻ cycle" : "missing"}
          </StubWarning>
        </span>
      </Row>
    );
  }

  // Full batch — the row's own authored amounts, plus engine-derived grams.
  const quantities = buildDisplayQuantities(row.row, gramById);
  const name = getIngredientName(row.row);
  const ref = entityRefForRow(row);

  // A div, not a label: the name is now a link, and an interactive <a> can't
  // live inside a <label> (the checkbox stays individually clickable).
  return (
    <Row
      align="baseline"
      gap="sm"
      className="border-b border-dashed border-border/60 py-2"
    >
      <input
        type="checkbox"
        aria-label={`Prep ${name}`}
        className="size-3.5 shrink-0 cursor-pointer self-center accent-primary"
      />
      <span className="flex-1 text-sm leading-snug">
        {row.kind === "subrecipe" && (
          <span aria-hidden className="mr-1 text-primary">
            ›
          </span>
        )}
        {ref ? (
          <EntityPreviewLink
            displayImage={
              row.kind === "subrecipe"
                ? recipeTreeDisplayImage(row.child.recipe)
                : null
            }
            entity={ref.entity}
            id={ref.id}
            className={dottedEntityLink}
          >
            {name}
          </EntityPreviewLink>
        ) : (
          name
        )}
        <IngredientModifier modifier={row.row.modifier} />
      </span>
      <IngredientQuantities
        quantities={quantities}
        className="shrink-0 text-xs whitespace-nowrap"
        emptyText="—"
      />
    </Row>
  );
}

function Component({
  node,
  index,
  usedGrams,
}: {
  node: RecipeTreeNode;
  index: number;
  usedGrams: number | undefined;
}) {
  const gramById = gramMapFromCosting(node.costing);
  const makes = formatMakes(
    node.recipe.yield,
    node.costing?.totals.weight ?? null,
  );
  // If the recipe consumes more than one batch of this sub-recipe, say so —
  // the block shows a single batch, so the cook needs to repeat it.
  const batch = batchYieldGrams(node);
  const batches =
    batch && usedGrams != null && usedGrams > batch * 1.01
      ? Math.ceil(usedGrams / batch)
      : 1;
  const steps = node.sections.flatMap((s) => s.steps);

  // Cost + macro atoms: this component's full-batch cost and its per-serving
  // macro split (basis = this component's own servings/yield).
  const batchCost = node.costing?.totals.price ?? null;
  const macro = node.costing
    ? recipeMacroSegments(node.costing.totals, getServingBasis(node.recipe), {
        includeCost: false,
      })
    : null;

  return (
    <section>
      <Row align="baseline" gap="sm" className="mb-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-2xs text-primary">
          {index + 1}
        </span>
        <h3 className="my-0 font-heading text-base leading-tight font-medium tracking-tight">
          <EntityPreviewLink
            displayImage={recipeTreeDisplayImage(node.recipe)}
            entity="recipe"
            id={node.recipe.id}
            className={dottedEntityLink}
          >
            {node.recipe.name}
          </EntityPreviewLink>
        </h3>
        <div className="ml-auto text-right font-mono text-2xs leading-tight tracking-wider text-slate uppercase">
          {makes && (
            <div>
              makes {makes}
              {batchCost != null && (
                <span className="text-foreground">
                  {" "}
                  · {formatCurrency(batchCost)}
                </span>
              )}
              {batches > 1 && (
                <span className="text-warning-ink"> · make {batches}×</span>
              )}
            </div>
          )}
          {usedGrams != null && (
            <div className="text-primary">{gramText(usedGrams)} used</div>
          )}
          {node.batchEstimated && (
            <div
              className="text-warning-ink"
              title={
                node.batchEstimatedReason
                  ? `Estimated: this sub-recipe ${blockReasonText(node.batchEstimatedReason)}`
                  : undefined
              }
            >
              batch est.
            </div>
          )}
        </div>
      </Row>

      {/* Per-serving macro split (kcal · P · F · C), the macro atom. */}
      {macro && macro.parts.length > 0 && (
        <div className="mb-2 font-mono text-2xs tracking-wide text-muted-foreground lowercase">
          {macro.basisLabel} · {macro.parts.join(" · ")}
        </div>
      )}

      <div className="border-t border-[var(--border)]">
        {node.sections.map((section, si) => (
          <div key={section.id}>
            {node.sections.length > 1 && section.name && (
              <div className="pt-2 pb-1 eyebrow">{section.name}</div>
            )}
            {section.rows.map((row) => (
              <PrepRow key={row.id} row={row} gramById={gramById} />
            ))}
            {si === node.sections.length - 1 && steps.length > 0 && (
              <Stack as="ol" gap="sm" className="mt-2 pl-0">
                {steps.map((step) => (
                  <Row as="li" gap="sm" key={step.n}>
                    <StepNumberBadge>{step.n}</StepNumberBadge>
                    <span className="text-sm leading-snug text-muted-foreground">
                      <MarkdownText className="[&_p]:my-0">
                        {step.text}
                      </MarkdownText>
                    </span>
                  </Row>
                ))}
              </Stack>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// memo: `tree` is referentially stable (useRecipeTree memoizes it), so this
// skips re-renders from RecipeDetail's streaming churn — without it the heavy
// per-row WASM formatting + markdown ran on every parent re-render (load freeze).
export const RecipePrepSheetView = memo(function RecipePrepSheetView({
  tree,
  hideGrid = false,
}: {
  tree: RecipeTreeNode;
  /** Omit the ingredient × component grid disclosure — the print/export sheet
   * has its own dedicated "matrix" format, so it doesn't need the in-app one. */
  hideGrid?: boolean;
}) {
  const recipe = tree.recipe;
  // Derived tree walks — memoized so RecipeDetail's streaming re-renders don't
  // re-run them (the tree itself is already stable from useRecipeTree).
  const components = useMemo(() => flattenComponents(tree), [tree]);
  const combined = useMemo(() => fullBatchNeeds(tree), [tree]);
  const usedByRecipe = useMemo(() => asUsedGramsByRecipe(tree), [tree]);
  const shoppingCost = useMemo(() => fullBatchCostByComponent(tree), [tree]);
  // The grid disclosure is collapsed by default; defer building/rendering it
  // (matrix walk + table) until the cook first opens it, then keep it mounted.
  const [gridOpened, setGridOpened] = useState(false);

  return (
    <Stack gap="lg" className="border border-[var(--border)] bg-card px-6 py-6">
      <header className="border-b-2 border-primary pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="my-0 font-heading text-2xl font-semibold tracking-tight">
            {recipe.name}
          </h2>
          {recipe.yield?.value ? (
            <span className="text-sm text-muted-foreground">
              {formatYield(recipe.yield)}
            </span>
          ) : null}
        </div>
        <span className="eyebrow">
          Prep sheet
          <span className="text-muted-foreground/50">
            {" · "}
            {components.length} component{components.length === 1 ? "" : "s"}
          </span>
        </span>
      </header>

      <ShoppingList
        needs={combined}
        totalCost={shoppingCost.total}
        totalCostUpper={shoppingCost.totalUpper}
      />

      {/* The ingredient × component pivot, folded in as a disclosure (collapsed)
          so it's reachable without a sub-tab; its Total column + cost row mirror
          the shopping list. Omitted on the print/export sheet (its own "matrix"
          format covers the pivot) and never printed. */}
      {!hideGrid && (
        <details
          onToggle={(e) => {
            if (e.currentTarget.open) setGridOpened(true);
          }}
          className="border border-[var(--border)] bg-muted/30 px-4 py-2 print:hidden"
        >
          <summary className="cursor-pointer eyebrow marker:content-none">
            <Grid3x3 className="mr-2 inline size-3 align-[-2px]" />
            Ingredient × component grid
          </summary>
          <div className="mt-2">
            {gridOpened && <IngredientComponentGrid tree={tree} showCost />}
          </div>
        </details>
      )}

      <Stack gap="lg">
        {components.map((node, i) => (
          <Component
            key={node.recipe.id}
            node={node}
            index={i}
            usedGrams={usedByRecipe.get(node.recipe.id)}
          />
        ))}
      </Stack>
    </Stack>
  );
});
