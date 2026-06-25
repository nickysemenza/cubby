import type { RecipeOut } from "@cubby/schemas/recipe";
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  BookOpen,
  ClipboardList,
  Grid3x3,
  ListChecks,
  Printer,
  Table2,
} from "lucide-react";
import type React from "react";
import { lazy, Suspense, useMemo, useState } from "react";
import { EntitySummaryCard } from "~/components/entity/entity-summary-card";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { TicketDivider } from "~/components/ui/ticket-divider";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useDebug } from "~/hooks/useDebug";
import { PerfProfiler } from "~/lib/perf/PerfProfiler";
import {
  type CostingRow,
  computeRecipeCosting,
  flattenSections,
} from "~/lib/recipe-costing";
import { deriveCostingGaps } from "~/lib/recipe-costing-gaps";
import { AuditLogList } from "../audit-log/audit-log-list";
import EntityImageList from "../EntityImageList";
import { useRecipeCostingData } from "../hooks/useRecipeCostingData";
import { CostingCoverageButton } from "./RecipeCostingCoverage";
import { RecipeMagazineView } from "./RecipeMagazineView";
import { RecipePrepSheetView } from "./RecipePrepSheetView";
import {
  type MissingWeightLink,
  RecipeScaleControl,
} from "./RecipeScaleControl";
import { RecipeSpecView } from "./RecipeSpecView";
import { RecipeCostingDebugCard } from "./recipe-costing-debug-card";
import { scaleRecipe } from "./recipe-scaling";
import { RecipeTagList } from "./recipe-tag";
import { getIngredientName, getServingBasis } from "./recipe-utils";
import { RecipeIngredientList } from "./recipeingredientlist";
import { useRecipeTree } from "./useRecipeTree";

// d3-hierarchy is heavy and only renders in the Data view's "charts" sub-mode, so
// keep it out of the recipe-detail route chunk until that sub-mode is opened.
const NutritionBars = lazy(
  () => import("~/app/_components/visualizations/nutrition-bars"),
);
const RecipeCostTreemap = lazy(
  () => import("~/app/_components/visualizations/recipe-cost-treemap"),
);

/** The four top-level recipe views. */
export type RecipeViewMode = "read" | "spec" | "data" | "prep";
/** Data view sub-mode: the numeric table or its charted form. */
export type RecipeDataMode = "table" | "charts";
/** Prep view sub-mode: the actionable checklist or the ingredient × component grid. */
export type RecipePrepMode = "checklist" | "grid";

const RECIPE_VIEW_OPTIONS: ViewSwitcherOption<RecipeViewMode>[] = [
  { value: "read", label: "Read", icon: BookOpen },
  { value: "spec", label: "Spec", icon: ClipboardList },
  { value: "data", label: "Data", icon: Table2 },
  { value: "prep", label: "Prep", icon: ListChecks },
];

const DATA_MODE_OPTIONS: ViewSwitcherOption<RecipeDataMode>[] = [
  { value: "table", label: "Table", icon: Table2 },
  { value: "charts", label: "Charts", icon: BarChart3 },
];

const PREP_MODE_OPTIONS: ViewSwitcherOption<RecipePrepMode>[] = [
  { value: "checklist", label: "Checklist", icon: ListChecks },
  { value: "grid", label: "Grid", icon: Grid3x3 },
];

/**
 * Normalize a URL view value — which may be one of the five legacy names from an
 * old bookmark — into the current {view, dataMode, prepMode} triple. The merges:
 * magazine→read, nested→spec, table/charts→data(+sub-mode), matrix→prep(grid).
 * Explicitly-passed sub-modes win; legacy names supply the implied sub-mode.
 */
export function remapLegacyView(
  view: string | undefined,
  dataMode: RecipeDataMode | undefined,
  prepMode: RecipePrepMode | undefined,
): {
  view: RecipeViewMode;
  dataMode: RecipeDataMode;
  prepMode: RecipePrepMode;
} {
  const data = dataMode ?? "table";
  const prep = prepMode ?? "checklist";
  switch (view) {
    case "read":
    case "spec":
    case "data":
    case "prep":
      return { view, dataMode: data, prepMode: prep };
    case "magazine":
      return { view: "read", dataMode: data, prepMode: prep };
    case "table":
      return { view: "data", dataMode: dataMode ?? "table", prepMode: prep };
    case "charts":
      return { view: "data", dataMode: dataMode ?? "charts", prepMode: prep };
    case "nested":
      return { view: "spec", dataMode: data, prepMode: prep };
    case "matrix":
      return { view: "prep", dataMode: data, prepMode: prepMode ?? "grid" };
    default:
      return { view: "read", dataMode: data, prepMode: prep };
  }
}

const RecipeDetailInner: React.FC<{
  recipe: RecipeOut;
  /** Controlled view mode (e.g. URL-driven on the detail route). */
  view?: RecipeViewMode;
  onViewChange?: (view: RecipeViewMode) => void;
  /** Controlled Data sub-mode (URL-driven on the detail route). */
  dataMode?: RecipeDataMode;
  onDataModeChange?: (mode: RecipeDataMode) => void;
  /** Controlled Prep sub-mode (URL-driven on the detail route). */
  prepMode?: RecipePrepMode;
  onPrepModeChange?: (mode: RecipePrepMode) => void;
  /** Controlled scale factor (URL-driven on the detail route); 1 = unscaled. */
  scale?: number;
  onScaleChange?: (factor: number) => void;
}> = ({
  recipe,
  view: controlledView,
  onViewChange,
  dataMode: controlledDataMode,
  onDataModeChange,
  prepMode: controlledPrepMode,
  onPrepModeChange,
  scale: controlledScale,
  onScaleChange,
}) => {
  // Controlled when the parent supplies view/onViewChange; otherwise self-managed
  // (e.g. the search preview panel embeds this without URL state).
  const [internalView, setInternalView] = useState<RecipeViewMode>("read");
  const [internalDataMode, setInternalDataMode] =
    useState<RecipeDataMode>("table");
  const [internalPrepMode, setInternalPrepMode] =
    useState<RecipePrepMode>("checklist");
  const [internalScale, setInternalScale] = useState(1);
  const { isDebugEnabled } = useDebug();
  const viewMode = controlledView ?? internalView;
  const setViewMode = onViewChange ?? setInternalView;
  const dataMode = controlledDataMode ?? internalDataMode;
  const setDataMode = onDataModeChange ?? setInternalDataMode;
  const prepMode = controlledPrepMode ?? internalPrepMode;
  const setPrepMode = onPrepModeChange ?? setInternalPrepMode;
  const factor = controlledScale ?? internalScale;
  const setFactor = onScaleChange ?? setInternalScale;

  // Derived scaled recipe: every amount (plus yield/servings) multiplied by the
  // factor. All downstream views + the costing engine consume this, so scaling
  // is a single transform upstream of the TS→WASM boundary. IDs are preserved.
  const scaledRecipe = useMemo(
    () => scaleRecipe(recipe, factor),
    [recipe, factor],
  );

  const ingredients: CostingRow[] = useMemo(
    () => flattenSections(scaledRecipe.sections),
    [scaledRecipe.sections],
  );

  // Get recipe images from the recipe object
  const recipeImages = recipe.images;

  // Load ingredient data plus the graph of any sub-recipes used as ingredients,
  // so cost/calories roll up correctly (data view). `ingMap` is null until the
  // first load completes. Keyed by ids (scaling doesn't change them), so use the
  // original recipe here to avoid refetch churn on scale.
  const recipesForData = useMemo(() => [recipe], [recipe]);
  const recipesForCosting = useMemo(() => [scaledRecipe], [scaledRecipe]);
  const { ingMap, recipeMap } = useRecipeCostingData(recipesForData);

  // The spec + prep views need every sub-recipe costed as its own root (the
  // closure-as-roots call) to expand the tree — so gate it on those view modes
  // to keep the common path (read/data) on the cheaper single call.
  const treeEnabled = viewMode === "spec" || viewMode === "prep";
  const { tree, costingById } = useRecipeTree(
    scaledRecipe,
    ingMap,
    recipeMap,
    treeEnabled,
  );

  // One engine call (Rust, via cost_recipes) per data change: totals + per-row
  // resolved measures — the usage-estimate overrides (absorbed frying oil,
  // to-taste salt, …) already applied — plus "est." markers and baker
  // percentages. When the tree is enabled it already costed the whole closure,
  // so reuse the root's entry instead of a second `cost_recipes` call (that
  // double-cost was the prep view's load-time freeze).
  const costing = useMemo(() => {
    if (costingById) return costingById.get(recipe.id) ?? null;
    return ingMap
      ? (computeRecipeCosting(
          recipesForCosting,
          ingMap,
          getIngredientName,
          recipeMap,
        ).get(recipe.id) ?? null)
      : null;
  }, [costingById, recipesForCosting, ingMap, recipeMap, recipe.id]);
  const totals = costing?.totals ?? null;
  const ingredientDataItems = costing?.rows ?? [];

  // Prioritized mapping suggestions for every ingredient this recipe can't
  // fully cost (no product, missing USDA link, missing price/weight mapping).
  // One source of truth — the coverage popover and the weight-scale popover below
  // both read from this, so they never disagree.
  const costingGaps = useMemo(
    () => (costing && ingMap ? deriveCostingGaps(costing, ingMap) : []),
    [costing, ingMap],
  );

  // The weight-only subset, for the total-weight scale anchor: ingredients whose
  // line can't reach grams, deep-linked to where the mapping is added.
  const missingWeightLinks = useMemo<MissingWeightLink[]>(
    () =>
      costingGaps
        .filter((gap) => gap.missing.weight)
        .map((gap) => ({
          ingredientId: gap.ingredientId,
          name: gap.name,
          productId: gap.productId,
        })),
    [costingGaps],
  );

  // Export format: spec ⇒ the "nested" markdown flavor, prep+grid ⇒ "matrix";
  // everything else uses the export sheet's default (prep).
  const exportFormat =
    viewMode === "spec"
      ? ("nested" as const)
      : viewMode === "prep" && prepMode === "grid"
        ? ("matrix" as const)
        : undefined;

  return (
    <Stack gap="lg">
      {/* Tags, Scale control, and View Toggle */}
      <Row
        align="center"
        justify="between"
        wrap
        gap="sm"
        className="print:hidden"
      >
        {recipe.tags && recipe.tags.length > 0 && (
          <RecipeTagList tags={recipe.tags} />
        )}
        <Row align="center" wrap gap="sm" className="ml-auto">
          {/* "Why isn't this costed?" — one compact popover on every view, so the
              affordance is always one click away without the bulky inline card. */}
          <CostingCoverageButton gaps={costingGaps} />
          <RecipeScaleControl
            recipe={recipe}
            totals={totals}
            missingWeightLinks={missingWeightLinks}
            factor={factor}
            onFactorChange={setFactor}
          />
          <ViewSwitcher
            ariaLabel="Recipe view"
            options={RECIPE_VIEW_OPTIONS}
            value={viewMode}
            onValueChange={setViewMode}
          />
          <Link
            to="/recipes/$id/export"
            params={{ id: recipe.id }}
            search={{
              format: exportFormat,
              scale: factor === 1 ? undefined : factor,
            }}
            className="inline-flex items-center gap-1 text-muted-foreground/70 text-xs hover:text-foreground"
            title="Open the print / export sheet"
          >
            <Printer className="h-3 w-3" />
            Print / export
          </Link>
        </Row>
      </Row>

      {/* Sub-mode toggle for the views that have one (Data, Prep). Its own row so
          it doesn't crowd the main switcher; URL-driven on the detail route. */}
      {viewMode === "data" && (
        <Row justify="end" className="print:hidden">
          <ViewSwitcher
            ariaLabel="Data sub-view"
            options={DATA_MODE_OPTIONS}
            value={dataMode}
            onValueChange={setDataMode}
          />
        </Row>
      )}
      {viewMode === "prep" && (
        <Row justify="end" className="print:hidden">
          <ViewSwitcher
            ariaLabel="Prep sub-view"
            options={PREP_MODE_OPTIONS}
            value={prepMode}
            onValueChange={setPrepMode}
          />
        </Row>
      )}

      {/* View Components */}
      {viewMode === "read" && (
        <RecipeMagazineView
          recipe={scaledRecipe}
          totals={totals}
          costing={costing}
        />
      )}
      {viewMode === "spec" &&
        (tree ? (
          <RecipeSpecView tree={tree} />
        ) : (
          <div className="h-[300px]">
            <SimpleLoading />
          </div>
        ))}
      {viewMode === "prep" &&
        (tree ? (
          <RecipePrepSheetView tree={tree} mode={prepMode} />
        ) : (
          <div className="h-[300px]">
            <SimpleLoading />
          </div>
        ))}
      {viewMode === "data" && dataMode === "table" && (
        <>
          {recipeImages.length > 0 && (
            <div className="mb-2">
              <EntityImageList images={recipeImages} />
            </div>
          )}
          <RecipeIngredientList
            ingredients={ingredients}
            ingMap={ingMap ?? undefined}
            costing={costing}
            perServing={getServingBasis(scaledRecipe)}
          />
        </>
      )}
      {viewMode === "data" && dataMode === "charts" && (
        <Stack gap="lg">
          {/* Yield/Servings Summary — the same shared card the table sub-mode
              uses, so the two never disagree on totals. */}
          {totals && (
            <EntitySummaryCard
              title="Recipe Summary"
              summaryData={{
                type: "recipe",
                data: {
                  price: totals.price,
                  weight: totals.weight,
                  nutrients: totals.nutrients,
                  totalIngredients: totals.totalIngredients,
                  missingByType: totals.missingByType,
                  perServing: getServingBasis(scaledRecipe),
                },
              }}
            />
          )}

          <Suspense
            fallback={
              <div className="h-[300px]">
                <SimpleLoading />
              </div>
            }
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Cost Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  {ingredientDataItems.length > 0 ? (
                    <RecipeCostTreemap
                      ingredients={ingredientDataItems}
                      totalCost={totals?.price ?? 0}
                    />
                  ) : (
                    <div className="h-[300px]">
                      <SimpleLoading />
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Nutrition Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  {ingredientDataItems.length > 0 ? (
                    <NutritionBars
                      ingredients={ingredientDataItems}
                      totals={totals}
                    />
                  ) : (
                    <div className="h-[300px]">
                      <SimpleLoading />
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </Suspense>
        </Stack>
      )}

      {/* Additional Images (for the reader view, if more than hero) */}
      {viewMode === "read" && recipeImages.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>More Images</CardTitle>
          </CardHeader>
          <CardContent>
            <EntityImageList images={recipeImages.slice(1)} />
          </CardContent>
        </Card>
      )}

      {/* Debug mode: how the totals were produced (usage, rules, errors, paths) */}
      {isDebugEnabled && <RecipeCostingDebugCard recipeId={recipe.id} />}

      {/* Tear line between the recipe itself and its paper trail */}
      <TicketDivider className="print:hidden" />

      {/* History Section */}
      <Card className="print:hidden">
        <CardHeader className="pb-2">
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <AuditLogList
            entityType="recipe"
            entityId={recipe.id}
            showEntityLink={false}
          />
        </CardContent>
      </Card>
    </Stack>
  );
};

// Profiled boundary so the perf overlay can attribute the recipe-detail render
// churn (the query-streaming re-render storm) to this subtree by name.
const RecipeDetail: React.FC<React.ComponentProps<typeof RecipeDetailInner>> = (
  props,
) => (
  // biome-ignore lint/correctness/useUniqueElementIds: React <Profiler> id, not a DOM id
  <PerfProfiler id="RecipeDetail">
    <RecipeDetailInner {...props} />
  </PerfProfiler>
);

export default RecipeDetail;
