import { Fragment, memo, useMemo } from "react";
import { MarkdownText } from "~/components/markdown";
import { cn } from "~/lib/utils";
import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import {
  buildDisplayQuantities,
  gramMapFromCosting,
  IngredientModifier,
  IngredientQuantities,
} from "./IngredientQuantities";
import { formatScalingPct } from "./recipe-scaling-pct";
import {
  firstExpansionRowIds,
  type RecipeTreeNode,
  type RecipeTreeRow,
} from "./recipe-tree";
import {
  entityRefForRow,
  formatYield,
  getIngredientName,
} from "./recipe-utils";

// Modernist-Cuisine-style spec sheet: the recipe and every sub-recipe expanded
// inline, recursively. Each node is a self-contained batch with its own
// quantity + scaling-% columns (% relative to that node's 100% base), and its
// method beneath. Sub-recipe rows show the as-used quantity in the parent, then
// the child's full table nests under a colored left-rule.
//
// NOTE: this is the one view that shows a sub-recipe's *as-used* amount in the
// parent row (spec convention: "130 g of [chicken]") — the prep sheet, matrix,
// and shopping list deliberately use *full batch* amounts (what you make/buy).
// The two bases coexist on purpose; don't "unify" them.

// Depth-keyed left-rule color (warm chart ramp tokens, never hardcoded hex).
// Capped so very deep trees reuse the last color rather than running off-ramp.
const DEPTH_RULE = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-5)",
  "var(--chart-7)",
];
const depthRule = (depth: number): string =>
  DEPTH_RULE[Math.min(depth, DEPTH_RULE.length - 1)] ?? "var(--chart-1)";

const rowGrid =
  "grid grid-cols-[minmax(0,1fr)_5rem_3.5rem] items-baseline gap-x-2";

function ScalingCell({
  pct,
  noWeight,
  isBase,
}: {
  pct: number | null;
  noWeight: boolean;
  isBase: boolean;
}) {
  return (
    <span
      className={cn(
        "text-right font-mono text-xs tabular-nums",
        pct == null
          ? noWeight
            ? "text-warning/80"
            : "text-muted-foreground/60"
          : isBase
            ? "font-medium text-primary"
            : "text-foreground/80",
      )}
    >
      {pct == null ? "—" : formatScalingPct(pct)}
    </span>
  );
}

function SpecRow({
  row,
  node,
  gramById,
  expanded,
}: {
  row: RecipeTreeRow;
  node: RecipeTreeNode;
  gramById: ReturnType<typeof gramMapFromCosting>;
  /** Sub-recipe row ids that render their full panel (vs. a "see above" pointer). */
  expanded: Set<string>;
}) {
  if (row.kind === "stub") {
    return (
      <div className={rowGrid}>
        <span className="py-1 text-muted-foreground text-sm italic">
          {row.name}{" "}
          <span className="font-mono text-2xs text-warning uppercase tracking-wide">
            {row.reason === "cycle" ? "↻ cycle" : "missing"}
          </span>
        </span>
        <span />
        <span />
      </div>
    );
  }

  const isBase = row.id === node.baseRowId;
  const noWeight = row.grams == null;
  const quantities = buildDisplayQuantities(row.row, gramById);
  const name = getIngredientName(row.row);
  const ref = entityRefForRow(row);
  // Tie a sub-recipe row's marker to the colored panel it opens below.
  const isSubrecipe = row.kind === "subrecipe";
  const isExpanded = isSubrecipe && expanded.has(row.id);
  const accentColor = isSubrecipe ? depthRule(row.child.depth) : undefined;

  const line = (
    <div className={cn(rowGrid, "align-top")}>
      <span className="py-1 font-medium text-sm leading-snug">
        {isSubrecipe && (
          <span aria-hidden className="mr-1" style={{ color: accentColor }}>
            {isExpanded ? "▾" : "▸"}
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
        {isSubrecipe && !isExpanded && (
          <span className="ml-2 align-middle font-mono text-[10px] text-muted-foreground/60 lowercase">
            ↑ see above
          </span>
        )}
        {isBase && (
          <span className="ml-2 rounded-sm bg-primary/10 px-1 py-px align-middle font-mono text-[9px] text-primary uppercase tracking-wide">
            100% base
          </span>
        )}
        {noWeight && row.kind === "ingredient" && (
          <span className="ml-2 rounded-sm bg-warning/15 px-1 py-px align-middle font-mono text-[9px] text-warning uppercase tracking-wide">
            no weight
          </span>
        )}
      </span>
      <IngredientQuantities
        quantities={quantities}
        className="text-xs"
        emptyText="—"
      />
      <ScalingCell pct={row.pct} noWeight={noWeight} isBase={isBase} />
    </div>
  );

  if (!isExpanded) return line;

  return (
    <>
      {line}
      <div
        className="mt-1 mb-2 ml-1 rounded-r-md border-l-[3px] bg-muted/40 py-2 pr-2 pl-2"
        style={{ borderLeftColor: accentColor }}
      >
        <SpecNode node={row.child} expanded={expanded} />
      </div>
    </>
  );
}

function SpecNode({
  node,
  expanded,
}: {
  node: RecipeTreeNode;
  expanded: Set<string>;
}) {
  const gramById = gramMapFromCosting(node.costing);
  const showSectionNames = node.sections.length > 1;
  const isRoot = node.depth === 0;

  return (
    <div className="space-y-1">
      {!isRoot && (
        <div className="mb-1 flex flex-wrap items-center gap-x-2 font-mono text-2xs uppercase tracking-wider">
          <EntityPreviewLink
            entity="recipe"
            id={node.recipe.id}
            className={cn(dottedEntityLink, "font-semibold")}
          >
            <span style={{ color: depthRule(node.depth) }}>
              {node.recipe.name}
            </span>
          </EntityPreviewLink>
          {node.recipe.yield?.value ? (
            <span className="text-eyebrow">
              · yields {formatYield(node.recipe.yield)}
            </span>
          ) : null}
          {node.batchEstimated && (
            <span className="text-warning">· batch est.</span>
          )}
        </div>
      )}

      {node.sections.map((section) => (
        <Fragment key={section.id}>
          {showSectionNames && section.name && (
            <div className="eyebrow pt-2">{section.name}</div>
          )}
          {section.rows.map((row) => (
            <SpecRow
              key={row.id}
              row={row}
              node={node}
              gramById={gramById}
              expanded={expanded}
            />
          ))}
          {section.steps.length > 0 && (
            <ol className="mt-2 mb-1 space-y-1 pl-0">
              {section.steps.map((step) => (
                <li key={step.n} className="flex gap-2">
                  <span className="mt-px inline-flex size-[16px] shrink-0 items-center justify-center rounded-full border border-[var(--border-chunky)] font-mono text-[9px] text-muted-foreground tabular-nums">
                    {step.n}
                  </span>
                  <span className="text-foreground/80 text-xs leading-snug">
                    <MarkdownText className="[&_p]:my-0">
                      {step.text}
                    </MarkdownText>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Fragment>
      ))}
    </div>
  );
}

// memo: skip re-renders from RecipeDetail's streaming churn (`tree` is stable).
export const RecipeNestedSpecView = memo(function RecipeNestedSpecView({
  tree,
}: {
  tree: RecipeTreeNode;
}) {
  const recipe = tree.recipe;
  const expanded = useMemo(() => firstExpansionRowIds(tree), [tree]);
  return (
    <div className="rounded-xl border border-[var(--border-chunky)] bg-card px-6 py-6">
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

      {recipe.notes && (
        <MarkdownText className="mb-4 max-w-prose text-muted-foreground">
          {recipe.notes}
        </MarkdownText>
      )}

      <div className={cn(rowGrid, "eyebrow border-primary border-b-2 pb-2")}>
        <span>Ingredient</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Scaling</span>
      </div>

      <div className="pt-2">
        <SpecNode node={tree} expanded={expanded} />
      </div>
    </div>
  );
});
