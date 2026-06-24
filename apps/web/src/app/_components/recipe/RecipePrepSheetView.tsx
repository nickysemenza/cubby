import { ShoppingCart } from "lucide-react";
import { memo, useMemo } from "react";
import { Row, Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
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
  fullBatchNeeds,
  type RecipeTreeNode,
  type RecipeTreeRow,
} from "./recipe-tree";
import {
  entityRefForRow,
  formatMakes,
  formatYield,
  getIngredientName,
  gramText,
} from "./recipe-utils";

// Prep sheet: the recipe broken into one block per component (every sub-recipe
// + the root assembly, dependencies first), each an actionable checklist with
// its steps. Components are shown at their FULL batch (clean authored amounts —
// you batch a sub-recipe, you don't make "0.16 of a chicken"); a per-component
// "X used" note + the top shopping list carry the as-used / UI-scaled totals.

function ShoppingList({ needs }: { needs: CombinedNeed[] }) {
  if (needs.length === 0) return null;
  return (
    <details
      open
      className="rounded-lg border border-[var(--border-chunky)] bg-muted/30 px-4 py-2 print:border-0 print:bg-transparent print:px-0"
    >
      <summary className="eyebrow cursor-pointer marker:content-none">
        <ShoppingCart className="mr-2 inline h-3 w-3 align-[-2px]" />
        Shopping list
        <span className="ml-1 text-muted-foreground/60">· full batch</span>
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {needs.map((need) => (
          <Row
            align="baseline"
            justify="between"
            gap="sm"
            key={need.ingredientId}
            className="border-border/50 border-b border-dashed py-1"
          >
            <span className="truncate">{need.name}</span>
            <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
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
        className="border-border/60 border-b border-dashed py-2"
      >
        <span className="size-3.5 shrink-0" />
        <span className="flex-1 text-muted-foreground text-sm italic">
          {row.name}{" "}
          <span className="font-mono text-2xs text-warning uppercase tracking-wide">
            {row.reason === "cycle" ? "↻ cycle" : "missing"}
          </span>
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
      className="border-border/60 border-b border-dashed py-2"
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
        className="shrink-0 whitespace-nowrap text-xs"
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

  return (
    <section>
      <Row align="baseline" gap="sm" className="mb-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[11px] text-primary">
          {index + 1}
        </span>
        <h3 className="my-0 font-heading font-medium text-base leading-tight tracking-tight">
          <EntityPreviewLink
            entity="recipe"
            id={node.recipe.id}
            className={dottedEntityLink}
          >
            {node.recipe.name}
          </EntityPreviewLink>
        </h3>
        <div className="ml-auto text-right font-mono text-2xs text-eyebrow uppercase leading-tight tracking-wider">
          {makes && (
            <div>
              makes {makes}
              {batches > 1 && (
                <span className="text-warning"> · make {batches}×</span>
              )}
            </div>
          )}
          {usedGrams != null && (
            <div className="text-primary">{gramText(usedGrams)} used</div>
          )}
          {node.batchEstimated && (
            <div className="text-warning">batch est.</div>
          )}
        </div>
      </Row>

      <div className="border-[var(--border-chunky)] border-t">
        {node.sections.map((section, si) => (
          <div key={section.id}>
            {node.sections.length > 1 && section.name && (
              <div className="eyebrow pt-2 pb-1">{section.name}</div>
            )}
            {section.rows.map((row) => (
              <PrepRow key={row.id} row={row} gramById={gramById} />
            ))}
            {si === node.sections.length - 1 && steps.length > 0 && (
              <Stack as="ol" gap="sm" className="mt-2 pl-0">
                {steps.map((step) => (
                  <Row as="li" gap="sm" key={step.n}>
                    <span className="mt-px inline-flex size-[17px] shrink-0 items-center justify-center rounded-full border border-[var(--border-chunky)] font-mono text-[9px] text-muted-foreground tabular-nums">
                      {step.n}
                    </span>
                    <span className="text-muted-foreground text-sm leading-snug">
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
}: {
  tree: RecipeTreeNode;
}) {
  const recipe = tree.recipe;
  // Derived tree walks — memoized so RecipeDetail's streaming re-renders don't
  // re-run them (the tree itself is already stable from useRecipeTree).
  const components = useMemo(() => flattenComponents(tree), [tree]);
  const combined = useMemo(() => fullBatchNeeds(tree), [tree]);
  const usedByRecipe = useMemo(() => asUsedGramsByRecipe(tree), [tree]);

  return (
    <Stack
      gap="lg"
      className="rounded-xl border border-[var(--border-chunky)] bg-card px-6 py-6"
    >
      <header className="border-primary border-b-2 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="my-0 font-heading font-semibold text-2xl tracking-tight">
            {recipe.name}
          </h2>
          {recipe.yield?.value ? (
            <span className="text-muted-foreground text-sm">
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

      <ShoppingList needs={combined} />

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
