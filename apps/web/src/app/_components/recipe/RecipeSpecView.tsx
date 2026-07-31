import { uniq } from "es-toolkit";
import { Fragment, memo, useMemo, useState } from "react";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { Row, Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { cn } from "~/lib/utils";
import { renderValueOrMissing } from "~/misc/result";
import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import {
  buildDisplayQuantities,
  gramMapFromCosting,
  IngredientModifier,
  IngredientQuantities,
} from "./IngredientQuantities";
import {
  computeScalingPercentages,
  formatScalingPct,
} from "./recipe-scaling-pct";
import { sourceFootnote } from "./recipe-source";
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
import {
  BasePill,
  NoWeightPill,
  SeeAbovePointer,
  StepNumberBadge,
  StubWarning,
} from "./spec-markers";

// Spec sheet: the engineering view. A flat recipe renders as a single bordered
// table (Ingredient · Qty · Cost · Scaling, method beneath each section); a
// recipe with sub-recipes auto-expands every sub-recipe inline, Modernist-
// Cuisine-style, each a self-contained batch with its OWN scaling base. This is
// the merged Spec ∪ Nested view.
//
// Scaling % is re-anchorable: click any row's % to make it this node's 100%
// base (per-node, keyed by recipe id), recomputed client-side from the grams the
// costing engine already resolved — no WASM round-trip. The Cost column shows
// the line's resolved price at its as-used amount (borrowed from the Data view).
//
// Sub-recipe rows show the *as-used* amount in the parent (spec convention:
// "130 g of [chicken]"); the child's full table nests under a colored left-rule.

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

type SpecVariant = "detail" | "export";

const rowGrid: Record<SpecVariant, string> = {
  detail:
    "grid grid-cols-[minmax(0,1fr)_4.5rem_4rem_3.5rem] items-baseline gap-x-2",
  export: "grid grid-cols-[minmax(0,1fr)_5rem_3.5rem] items-baseline gap-x-2",
};

/** Per-node base override: recipe id → the row chosen as that node's 100% base. */
type BaseOverrides = Map<string, string>;

function CostCell({ node, rowId }: { node: RecipeTreeNode; rowId: string }) {
  const price = node.costing?.rows.find((r) => r.id === rowId)?.priceInfo
    ?.price;
  return (
    <span className="text-right font-mono text-muted-foreground text-xs tabular-nums">
      {price ? (
        renderValueOrMissing(price, (m) => tryFormatAmount(m))
      ) : (
        <span className="text-muted-foreground/40">·</span>
      )}
    </span>
  );
}

function ScalingCell({
  pct,
  noWeight,
  isBase,
  onPick,
}: {
  pct: number | null;
  noWeight: boolean;
  isBase: boolean;
  onPick?: () => void;
}) {
  if (pct == null) {
    return (
      <span
        className={cn(
          "text-right font-mono text-xs tabular-nums",
          noWeight ? "text-warning/80" : "text-muted-foreground",
        )}
      >
        —
      </span>
    );
  }
  if (!onPick) {
    return (
      <span
        className={cn(
          "text-right font-mono text-xs tabular-nums",
          isBase ? "font-medium text-primary" : "text-foreground",
        )}
      >
        {formatScalingPct(pct)}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={isBase}
      title="Set as 100% base"
      className={cn(
        "cursor-pointer text-right font-mono text-xs tabular-nums hover:text-primary",
        isBase ? "font-medium text-primary" : "text-foreground",
      )}
    >
      {formatScalingPct(pct)}
    </button>
  );
}

function SpecRow({
  row,
  node,
  baseId,
  pct,
  gramById,
  expanded,
  overrides,
  setBase,
  variant,
}: {
  row: RecipeTreeRow;
  node: RecipeTreeNode;
  baseId: string | null;
  pct: number | null;
  gramById: ReturnType<typeof gramMapFromCosting>;
  /** Sub-recipe row ids that render their full panel (vs. a "see above" pointer). */
  expanded: Set<string>;
  overrides: BaseOverrides;
  setBase: (recipeId: string, rowId: string) => void;
  variant: SpecVariant;
}) {
  if (row.kind === "stub") {
    return (
      <div className={rowGrid[variant]}>
        <span className="py-1 text-muted-foreground text-sm italic">
          {row.name}{" "}
          <StubWarning>
            {row.reason === "cycle" ? "↻ cycle" : "missing"}
          </StubWarning>
        </span>
        {variant === "detail" && <span />}
        <span />
        <span />
      </div>
    );
  }

  const isBase = row.id === baseId;
  const noWeight = row.grams == null;
  const quantities = buildDisplayQuantities(row.row, gramById);
  const name = getIngredientName(row.row);
  const ref = entityRefForRow(row);
  // Tie a sub-recipe row's marker to the colored panel it opens below.
  const isSubrecipe = row.kind === "subrecipe";
  const isExpanded = isSubrecipe && expanded.has(row.id);
  const accentColor = isSubrecipe ? depthRule(row.child.depth) : undefined;

  const line = (
    <div className={cn(rowGrid[variant], "align-top")}>
      <span className="py-1 font-medium text-sm leading-snug">
        {isSubrecipe && (
          <span aria-hidden className="mr-1" style={{ color: accentColor }}>
            {isExpanded ? "▾" : "▸"}
          </span>
        )}
        {ref ? (
          <EntityPreviewLink
            entity={ref.entity}
            shortcode={ref.shortcode}
            id={ref.id}
            className={dottedEntityLink}
          >
            {name}
          </EntityPreviewLink>
        ) : (
          name
        )}
        <IngredientModifier modifier={row.row.modifier} />
        {isSubrecipe && !isExpanded && <SeeAbovePointer />}
        {isBase && <BasePill />}
        {noWeight && row.kind === "ingredient" && <NoWeightPill />}
      </span>
      <IngredientQuantities
        quantities={quantities}
        className="text-xs"
        emptyText="—"
      />
      {variant === "detail" && <CostCell node={node} rowId={row.id} />}
      <ScalingCell
        pct={pct}
        noWeight={noWeight}
        isBase={isBase}
        onPick={
          variant === "detail"
            ? () => setBase(node.recipe.id, row.id)
            : undefined
        }
      />
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
        <SpecNode
          node={row.child}
          expanded={expanded}
          overrides={overrides}
          setBase={setBase}
          variant={variant}
        />
      </div>
    </>
  );
}

function SpecNode({
  node,
  expanded,
  overrides,
  setBase,
  variant,
}: {
  node: RecipeTreeNode;
  expanded: Set<string>;
  overrides: BaseOverrides;
  setBase: (recipeId: string, rowId: string) => void;
  variant: SpecVariant;
}) {
  const gramById = gramMapFromCosting(node.costing);
  const showSectionNames = node.sections.length > 1;
  const isRoot = node.depth === 0;

  // Re-anchorable base: the user's pick for this node, else its default
  // (flour/heaviest). Percentages are recomputed client-side from resolved grams.
  const baseId =
    variant === "detail"
      ? (overrides.get(node.recipe.id) ?? node.baseRowId)
      : node.baseRowId;
  const pctById = useMemo(
    () =>
      variant === "detail" && node.costing
        ? computeScalingPercentages(node.costing, baseId)
        : new Map<string, number | null>(),
    [node.costing, baseId, variant],
  );

  return (
    <Stack gap="xs">
      {!isRoot && (
        <div className="eyebrow mb-1 flex flex-wrap items-center gap-x-2">
          <EntityPreviewLink
            entity="recipe"
            shortcode={node.recipe.shortcode}
            id={node.recipe.id}
            className={cn(dottedEntityLink, "font-semibold")}
          >
            <span style={{ color: depthRule(node.depth) }}>
              {node.recipe.name}
            </span>
          </EntityPreviewLink>
          {node.recipe.yield?.value ? (
            <span className="text-slate">
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
              baseId={baseId}
              pct={
                variant === "detail"
                  ? (pctById.get(row.id) ?? null)
                  : "pct" in row
                    ? row.pct
                    : null
              }
              gramById={gramById}
              expanded={expanded}
              overrides={overrides}
              setBase={setBase}
              variant={variant}
            />
          ))}
          {section.steps.length > 0 && (
            <Stack as="ol" gap="xs" className="mt-2 mb-1 pl-0">
              {section.steps.map((step) => (
                <Row as="li" gap="sm" key={step.n}>
                  <StepNumberBadge>{step.n}</StepNumberBadge>
                  <span className="text-foreground text-xs leading-snug">
                    <MarkdownText className="[&_p]:my-0">
                      {step.text}
                    </MarkdownText>
                  </span>
                </Row>
              ))}
            </Stack>
          )}
        </Fragment>
      ))}
    </Stack>
  );
}

// memo: skip re-renders from RecipeDetail's streaming churn (`tree` is stable).
export const RecipeSpecView = memo(function RecipeSpecView({
  tree,
  variant = "detail",
}: {
  tree: RecipeTreeNode;
  variant?: SpecVariant;
}) {
  const recipe = tree.recipe;
  const expanded = useMemo(() => firstExpansionRowIds(tree), [tree]);
  const [overrides, setOverrides] = useState<BaseOverrides>(new Map());
  const setBase = (recipeId: string, rowId: string) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(recipeId, rowId);
      return next;
    });

  const footnote = sourceFootnote(recipe.source);
  const missingWeight = tree.costing?.totals.missingByType.weight ?? [];

  return (
    <div className="rounded-xl border border-[var(--border)] bg-card px-6 py-6">
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

      <div
        className={cn(
          rowGrid[variant],
          "eyebrow border-primary border-b-2 pb-2",
        )}
      >
        <span>Ingredient</span>
        <span className="text-right">Qty</span>
        {variant === "detail" && <span className="text-right">Cost</span>}
        <span className="text-right">Scaling</span>
      </div>

      <div className="pt-2">
        <SpecNode
          node={tree}
          expanded={expanded}
          overrides={overrides}
          setBase={setBase}
          variant={variant}
        />
      </div>

      {variant === "detail" && footnote && (
        <p className="mt-4 font-heading text-primary text-xs italic">
          {footnote}
        </p>
      )}

      {variant === "detail" && missingWeight.length > 0 && (
        <p className="mt-2 font-mono text-2xs text-muted-foreground">
          Scaling omits{" "}
          <span className="text-warning">{uniq(missingWeight).join(", ")}</span>{" "}
          — no weight.
        </p>
      )}
    </div>
  );
});
