import type { RecipeOut } from "@cubby/schemas/recipe";
import { Link } from "@tanstack/react-router";
import {
  Apple,
  BookOpen,
  ClipboardList,
  Clock,
  Coffee,
  GitBranch,
  ImageIcon,
  ListChecks,
  Printer,
  Table2,
} from "lucide-react";
import type React from "react";
import { lazy, Suspense, useMemo, useState } from "react";
import { match } from "ts-pattern";
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
import { useWakeLock } from "~/hooks/useWakeLock";
import { PerfProfiler } from "~/lib/perf/PerfProfiler";
import {
  type CostingRow,
  computeRecipeCosting,
  flattenSections,
} from "~/lib/recipe-costing";
import { deriveRecipeTotalsGaps } from "~/lib/recipe-totals-gaps";
import { cn } from "~/lib/utils";
import { AuditLogList } from "../audit-log/audit-log-list";
import EntityImageList from "../EntityImageList";
import { useRecipeCostingData } from "../hooks/useRecipeCostingData";
import { NutritionLabel } from "../nutrition/NutritionLabel";
import { RecipeTotalsCoverageButton } from "./RecipeCostingCoverage";
import { type RecipeFlowLayoutMode, RecipeFlowView } from "./RecipeFlowView";
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
import {
  divideNutrients,
  getIngredientName,
  getServingBasis,
} from "./recipe-utils";
import { RecipeIngredientList } from "./recipeingredientlist";
import { useRecipeTree } from "./useRecipeTree";

// d3-hierarchy is heavy and only renders in the Data view, so keep it out of the
// recipe-detail route chunk until that view is opened (lazy import + Suspense).
const NutritionBars = lazy(
  () => import("~/app/_components/visualizations/nutrition-bars"),
);
const RecipeCostTreemap = lazy(
  () => import("~/app/_components/visualizations/recipe-cost-treemap"),
);

/** The five top-level recipe views. Data stacks its charts above the table and
 * Prep folds its ingredient × component grid in as a disclosure, so there are no
 * sub-modes — one flat row of tabs. */
export type RecipeViewMode = "read" | "spec" | "data" | "prep" | "flow";

const RECIPE_VIEW_OPTIONS: ViewSwitcherOption<RecipeViewMode>[] = [
  { value: "read", label: "Read", icon: BookOpen },
  { value: "spec", label: "Spec", icon: ClipboardList },
  { value: "data", label: "Data", icon: Table2 },
  { value: "prep", label: "Prep", icon: ListChecks },
  { value: "flow", label: "Flow", icon: GitBranch },
];

/**
 * Normalize a URL view value — which may be one of the legacy names from an old
 * bookmark — into a current view. The merges: magazine→read, nested→spec,
 * table/charts→data, matrix→prep. (The former table/charts and checklist/grid
 * sub-modes are gone; charts stack inside Data and the grid folds into Prep.)
 */
export function remapLegacyView(view: string | undefined): RecipeViewMode {
  return match(view)
    .with("read", "spec", "data", "prep", "flow", (v) => v)
    .with("magazine", () => "read" as const)
    .with("table", "charts", () => "data" as const)
    .with("nested", () => "spec" as const)
    .with("matrix", () => "prep" as const)
    .otherwise(() => "read" as const);
}

const RecipeDetailInner: React.FC<{
  recipe: RecipeOut;
  /** Controlled view mode (e.g. URL-driven on the detail route). */
  view?: RecipeViewMode;
  onViewChange?: (view: RecipeViewMode) => void;
  /** Controlled scale factor (URL-driven on the detail route); 1 = unscaled. */
  scale?: number;
  onScaleChange?: (factor: number) => void;
  flowLayout?: RecipeFlowLayoutMode;
  onFlowLayoutChange?: (layout: RecipeFlowLayoutMode) => void;
}> = ({
  recipe,
  view: controlledView,
  onViewChange,
  scale: controlledScale,
  onScaleChange,
  flowLayout,
  onFlowLayoutChange,
}) => {
  // Controlled when the parent supplies view/onViewChange; otherwise self-managed
  // (e.g. the search preview panel embeds this without URL state).
  const [internalView, setInternalView] = useState<RecipeViewMode>("read");
  const [internalScale, setInternalScale] = useState(1);
  const { isDebugEnabled } = useDebug();
  // Kitchen mode: keep the screen awake while the recipe is propped on the
  // counter (iOS auto-locks after ~30s mid-cook). Off by default.
  const wakeLock = useWakeLock();
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

  // Nutrition Facts label data: totals divided down to one serving when the
  // recipe has a serving basis (servings, or a "makes N units" yield),
  // otherwise the whole-recipe totals as-is.
  const servingBasis = getServingBasis(scaledRecipe);
  const nutritionServingLabel = servingBasis
    ? `per ${servingBasis.noun}`
    : "whole recipe";
  const nutritionDivisor = servingBasis?.divisor;
  const nutritionNutrients = useMemo(
    () =>
      totals && nutritionDivisor
        ? divideNutrients(totals.nutrients, nutritionDivisor)
        : (totals?.nutrients ?? null),
    [totals, nutritionDivisor],
  );

  // Prioritized suggestions for every row blocking complete totals: ingredient
  // enrichment plus sub-recipe amount/yield/child-total fixes.
  // One source of truth — the coverage popover and the weight-scale popover below
  // both read from this, so they never disagree.
  const totalsGaps = useMemo(
    () => (costing && ingMap ? deriveRecipeTotalsGaps(costing, ingMap) : []),
    [costing, ingMap],
  );

  // The weight-only subset, for the total-weight scale anchor: ingredients whose
  // line can't reach grams, deep-linked to where the mapping is added.
  const missingWeightLinks = useMemo<MissingWeightLink[]>(
    () =>
      totalsGaps.flatMap((gap) =>
        gap.source === "ingredient" && gap.missing.weight
          ? [
              {
                ingredientShortcode: gap.ingredientShortcode,
                name: gap.name,
                productShortcode: gap.productShortcode,
              },
            ]
          : [],
      ),
    [totalsGaps],
  );

  // Export format: spec ⇒ the "nested" markdown flavor; everything else uses the
  // export sheet's own format picker (which still offers prep / nested / matrix).
  const exportFormat =
    viewMode === "spec"
      ? ("nested" as const)
      : viewMode === "flow"
        ? ("flow" as const)
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
          {/* Kitchen mode: hold the screen awake while cooking. Feature-detected —
              hidden on browsers without the Wake Lock API. */}
          {wakeLock.supported && (
            <button
              type="button"
              onClick={wakeLock.toggle}
              aria-pressed={wakeLock.enabled}
              title={
                wakeLock.enabled
                  ? "Screen stays awake while cooking — tap to allow sleep"
                  : "Keep screen awake while cooking"
              }
              className={cn(
                "inline-flex items-center gap-1 border px-2 py-1 text-xs",
                wakeLock.enabled
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <Coffee className="size-3.5" />
              {wakeLock.enabled ? "Awake" : "Keep awake"}
            </button>
          )}
          {/* "Why aren't these totals complete?" — one compact popover on every view, so the
              affordance is always one click away without the bulky inline card. */}
          <RecipeTotalsCoverageButton
            gaps={totalsGaps}
            currentRecipeId={recipe.id}
            currentRecipeShortcode={recipe.id}
          />
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
            to="/recipes/$shortcode/export"
            params={{ shortcode: recipe.id }}
            search={{
              format: exportFormat,
              scale: factor === 1 ? undefined : factor,
            }}
            className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
            title="Open the print / export sheet"
          >
            <Printer className="size-3" />
            Print / export
          </Link>
        </Row>
      </Row>

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
          <RecipePrepSheetView tree={tree} />
        ) : (
          <div className="h-[300px]">
            <SimpleLoading />
          </div>
        ))}
      {viewMode === "flow" && (
        <RecipeFlowView
          recipe={recipe}
          scaledRecipe={scaledRecipe}
          layout={flowLayout}
          onLayoutChange={onFlowLayoutChange}
        />
      )}
      {viewMode === "data" && (
        <Stack gap="lg">
          {/* Recipe Summary — rendered once here; the table below omits its own. */}
          {totals && (
            <EntitySummaryCard
              title="Recipe Summary"
              summaryData={{
                type: "recipe",
                data: {
                  price: totals.price,
                  // Carry the range upper bounds (ranged amounts like "1–2 cups")
                  // so the card shows "$4.50–$6.20", matching the table's own card.
                  ...(totals.priceUpper != null
                    ? { priceUpper: totals.priceUpper }
                    : {}),
                  weight: totals.weight,
                  ...(totals.weightUpper != null
                    ? { weightUpper: totals.weightUpper }
                    : {}),
                  nutrients: totals.nutrients,
                  ...(totals.nutrientsUpper
                    ? { nutrientsUpper: totals.nutrientsUpper }
                    : {}),
                  totalIngredients: totals.totalIngredients,
                  missingByType: totals.missingByType,
                  perServing: getServingBasis(scaledRecipe),
                },
              }}
            />
          )}

          {/* Charts overview, stacked above the table (d3 stays lazy-loaded). */}
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

          {recipeImages.length > 0 && <EntityImageList images={recipeImages} />}
          <RecipeIngredientList
            ingredients={ingredients}
            ingMap={ingMap ?? undefined}
            costing={costing}
            perServing={getServingBasis(scaledRecipe)}
            hideSummary
            gaps={totalsGaps}
            recipeShortcode={recipe.id}
          />
        </Stack>
      )}

      {/* Additional Images (for the reader view, if more than hero) */}
      {viewMode === "read" && recipeImages.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle icon={ImageIcon}>More Images</CardTitle>
          </CardHeader>
          <CardContent>
            <EntityImageList images={recipeImages.slice(1)} />
          </CardContent>
        </Card>
      )}

      {/* Nutrition Facts — collapsed by default, same details/summary pattern as
          the prep sheet's shopping list. Independent of view mode: shows
          whenever the costing engine has produced nutrient totals. */}
      {nutritionNutrients && (
        <details className="group border border-border bg-muted/30 px-4 py-2 print:hidden">
          <summary className="eyebrow cursor-pointer marker:content-none">
            <Apple className="mr-2 inline size-3 align-[-2px]" />
            Nutrition
          </summary>
          <div className="mt-4">
            <NutritionLabel
              nutrients={nutritionNutrients}
              servingLabel={nutritionServingLabel}
            />
          </div>
        </details>
      )}

      {/* Debug mode: how the totals were produced (usage, rules, errors, paths) */}
      {isDebugEnabled && <RecipeCostingDebugCard recipeId={recipe.id} />}

      {/* Tear line between the recipe itself and its paper trail */}
      <TicketDivider className="print:hidden" />

      {/* History Section */}
      <Card className="print:hidden">
        <CardHeader className="pb-2">
          <CardTitle icon={Clock}>History</CardTitle>
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
