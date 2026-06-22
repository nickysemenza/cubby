import type { RecipeOut } from "@cubby/schemas/recipe";
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  BookOpen,
  ClipboardList,
  Grid3x3,
  ListChecks,
  ListTree,
  Printer,
  Table2,
} from "lucide-react";
import type React from "react";
import { lazy, Suspense, useMemo, useState } from "react";
import { EntitySummaryCard } from "~/components/entity/entity-summary-card";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
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
import {
  CostingCoverageButton,
  RecipeCostingCoverage,
} from "./RecipeCostingCoverage";
import { RecipeIngredientMatrixView } from "./RecipeIngredientMatrixView";
import { RecipeMagazineView } from "./RecipeMagazineView";
import { RecipeNestedSpecView } from "./RecipeNestedSpecView";
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

// d3-hierarchy is heavy and only renders in the "charts" view, so keep it out
// of the recipe-detail route chunk until that tab is opened.
const NutritionBars = lazy(
  () => import("~/app/_components/visualizations/nutrition-bars"),
);
const RecipeCostTreemap = lazy(
  () => import("~/app/_components/visualizations/recipe-cost-treemap"),
);

export type RecipeViewMode =
  | "magazine"
  | "spec"
  | "table"
  | "charts"
  | "prep"
  | "nested"
  | "matrix";

const RECIPE_VIEW_OPTIONS: ViewSwitcherOption<RecipeViewMode>[] = [
  { value: "magazine", label: "Magazine", icon: BookOpen },
  { value: "spec", label: "Spec", icon: ClipboardList },
  { value: "table", label: "Table", icon: Table2 },
  { value: "charts", label: "Charts", icon: BarChart3 },
  { value: "prep", label: "Prep", icon: ListChecks },
  { value: "nested", label: "Nested", icon: ListTree },
  { value: "matrix", label: "Matrix", icon: Grid3x3 },
];

const RecipeDetailInner: React.FC<{
  recipe: RecipeOut;
  /** Controlled view mode (e.g. URL-driven on the detail route). */
  view?: RecipeViewMode;
  onViewChange?: (view: RecipeViewMode) => void;
  /** Controlled scale factor (URL-driven on the detail route); 1 = unscaled. */
  scale?: number;
  onScaleChange?: (factor: number) => void;
}> = ({
  recipe,
  view: controlledView,
  onViewChange,
  scale: controlledScale,
  onScaleChange,
}) => {
  // Controlled when the parent supplies view/onViewChange; otherwise self-managed
  // (e.g. the search preview panel embeds this without URL state).
  const [internalView, setInternalView] = useState<RecipeViewMode>("magazine");
  const [internalScale, setInternalScale] = useState(1);
  const { isDebugEnabled } = useDebug();
  const viewMode = controlledView ?? internalView;
  const setViewMode = onViewChange ?? setInternalView;
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
  // so cost/calories roll up correctly (table and charts views). `ingMap` is
  // null until the first load completes. Keyed by ids (scaling doesn't change
  // them), so use the original recipe here to avoid refetch churn on scale.
  const recipesForData = useMemo(() => [recipe], [recipe]);
  const recipesForCosting = useMemo(() => [scaledRecipe], [scaledRecipe]);
  const { ingMap, recipeMap } = useRecipeCostingData(recipesForData);

  // The prep-sheet/nested/matrix views need every sub-recipe costed as its own
  // root (the closure-as-roots call), which the other views don't — so gate it
  // on those view modes to keep the common path on the cheaper single call.
  const treeEnabled =
    viewMode === "prep" || viewMode === "nested" || viewMode === "matrix";
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
  // One source of truth — the coverage panel and the weight-scale popover below
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

  return (
    <div className="space-y-6">
      {/* Tags, Scale control, and View Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        {recipe.tags && recipe.tags.length > 0 && (
          <RecipeTagList tags={recipe.tags} />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* View-independent "why isn't this costed?" affordance — the full
              inline card only shows in table/charts, so surface it as a compact
              popover everywhere else. */}
          {viewMode !== "table" && viewMode !== "charts" && (
            <CostingCoverageButton gaps={costingGaps} />
          )}
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
              format:
                viewMode === "nested" || viewMode === "matrix"
                  ? viewMode
                  : undefined,
              scale: factor === 1 ? undefined : factor,
            }}
            className="inline-flex items-center gap-1 text-muted-foreground/70 text-xs hover:text-foreground"
            title="Open the print / export sheet"
          >
            <Printer className="h-3 w-3" />
            Print / export
          </Link>
        </div>
      </div>

      {/* Actionable costing-coverage suggestions (table/charts views, where cost
          matters). Hidden in the reader-facing magazine view and when fully costed. */}
      {(viewMode === "table" || viewMode === "charts") && (
        <RecipeCostingCoverage gaps={costingGaps} />
      )}

      {/* View Components */}
      {viewMode === "magazine" && (
        <RecipeMagazineView
          recipe={scaledRecipe}
          totals={totals}
          costing={costing}
        />
      )}
      {viewMode === "spec" && (
        <RecipeSpecView
          recipe={scaledRecipe}
          totals={totals}
          costing={costing}
        />
      )}
      {viewMode === "prep" &&
        (tree ? (
          <RecipePrepSheetView tree={tree} />
        ) : (
          <div className="h-[300px]">
            <SimpleLoading />
          </div>
        ))}
      {viewMode === "nested" &&
        (tree ? (
          <RecipeNestedSpecView tree={tree} />
        ) : (
          <div className="h-[300px]">
            <SimpleLoading />
          </div>
        ))}
      {viewMode === "matrix" &&
        (tree ? (
          <RecipeIngredientMatrixView tree={tree} />
        ) : (
          <div className="h-[300px]">
            <SimpleLoading />
          </div>
        ))}
      {viewMode === "table" && (
        <>
          {/* Images for table view */}
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
      {viewMode === "charts" && (
        <div className="space-y-6">
          {/* Yield/Servings Summary — the same shared card the table view uses,
              so the two views never disagree on totals. */}
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
        </div>
      )}

      {/* Additional Images (for magazine view, if more than hero) */}
      {viewMode === "magazine" && recipeImages.length > 1 && (
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
    </div>
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
