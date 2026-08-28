import type { RecipeOut } from "@cubby/schemas/recipe";
import { Link } from "@tanstack/react-router";
import {
  Apple,
  BookOpen,
  ClipboardList,
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

import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/entity/entity-summary-card";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useDebug } from "~/hooks/useDebug";
import { useWakeLock } from "~/hooks/useWakeLock";
import { PerfProfiler } from "~/lib/perf/PerfProfiler";
import {
  type CalculateTotalsResult,
  type CostingRow,
  type RecipeCosting,
  computeRecipeCosting,
  flattenSections,
} from "~/lib/recipe-costing";
import { deriveRecipeTotalsGaps } from "~/lib/recipe-totals-gaps";
import { cn } from "~/lib/utils";

import { type DetailSection, DetailSections } from "../data-table/detail-page";
import EntityImageList from "../EntityImageList";
import { useRecipeCostingData } from "../hooks/useRecipeCostingData";
import { NutritionLabel } from "../nutrition/NutritionLabel";
import { RecipeCostingDebugCard } from "./recipe-costing-debug-card";
import { scaleRecipe } from "./recipe-scaling";
import { RecipeTagList } from "./recipe-tag";
import {
  divideNutrients,
  getIngredientName,
  getServingBasis,
} from "./recipe-utils";
import { RecipeTotalsCoverageButton } from "./RecipeCostingCoverage";
import { type RecipeFlowLayoutMode, RecipeFlowView } from "./RecipeFlowView";
import { RecipeIngredientList } from "./recipeingredientlist";
import { RecipeMagazineView } from "./RecipeMagazineView";
import { RecipePrepSheetView } from "./RecipePrepSheetView";
import {
  type MissingWeightLink,
  RecipeScaleControl,
} from "./RecipeScaleControl";
import { RecipeSpecView } from "./RecipeSpecView";
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

function RecipeViewContent({
  viewMode,
  recipe,
  scaledRecipe,
  tree,
  totals,
  costing,
  flowLayout,
  onFlowLayoutChange,
  ingredientDataItems,
  recipeImages,
  ingredients,
  ingMap,
  totalsGaps,
}: {
  viewMode: RecipeViewMode;
  recipe: RecipeOut;
  scaledRecipe: RecipeOut;
  tree: React.ComponentProps<typeof RecipeSpecView>["tree"] | null;
  totals: CalculateTotalsResult | null;
  costing: RecipeCosting | null;
  flowLayout?: RecipeFlowLayoutMode;
  onFlowLayoutChange?: (layout: RecipeFlowLayoutMode) => void;
  ingredientDataItems: RecipeCosting["rows"];
  recipeImages: RecipeOut["images"];
  ingredients: CostingRow[];
  ingMap: Parameters<typeof RecipeIngredientList>[0]["ingMap"];
  totalsGaps: React.ComponentProps<typeof RecipeTotalsCoverageButton>["gaps"];
}) {
  if (viewMode === "read")
    return (
      <RecipeMagazineView
        recipe={scaledRecipe}
        totals={totals}
        costing={costing}
      />
    );
  if (viewMode === "spec" || viewMode === "prep") {
    if (!tree) return <LoadingRecipeView />;
    return viewMode === "spec" ? (
      <RecipeSpecView tree={tree} />
    ) : (
      <RecipePrepSheetView tree={tree} />
    );
  }
  if (viewMode === "flow")
    return (
      <RecipeFlowView
        recipe={recipe}
        scaledRecipe={scaledRecipe}
        layout={flowLayout}
        onLayoutChange={onFlowLayoutChange}
      />
    );
  return (
    <RecipeDataView
      totals={totals}
      ingredientDataItems={ingredientDataItems}
      recipeImages={recipeImages}
      ingredients={ingredients}
      ingMap={ingMap}
      costing={costing}
      scaledRecipe={scaledRecipe}
      totalsGaps={totalsGaps}
      recipeShortcode={recipe.id}
    />
  );
}

function LoadingRecipeView() {
  return (
    <div className="h-[300px]">
      <SimpleLoading />
    </div>
  );
}

function RecipeDataView({
  totals,
  ingredientDataItems,
  recipeImages,
  ingredients,
  ingMap,
  costing,
  scaledRecipe,
  totalsGaps,
  recipeShortcode,
}: {
  totals: CalculateTotalsResult | null;
  ingredientDataItems: RecipeCosting["rows"];
  recipeImages: RecipeOut["images"];
  ingredients: CostingRow[];
  ingMap: Parameters<typeof RecipeIngredientList>[0]["ingMap"];
  costing: RecipeCosting | null;
  scaledRecipe: RecipeOut;
  totalsGaps: React.ComponentProps<typeof RecipeTotalsCoverageButton>["gaps"];
  recipeShortcode: RecipeOut["id"];
}) {
  return (
    <Stack gap="lg">
      <RecipeSummary totals={totals} recipe={scaledRecipe} />
      <RecipeDataCharts ingredients={ingredientDataItems} totals={totals} />
      {recipeImages.length > 0 ? (
        <EntityImageList images={recipeImages} />
      ) : null}
      <RecipeIngredientList
        ingredients={ingredients}
        ingMap={ingMap ?? undefined}
        costing={costing}
        perServing={getServingBasis(scaledRecipe)}
        hideSummary
        gaps={totalsGaps}
        recipeShortcode={recipeShortcode}
      />
    </Stack>
  );
}

function RecipeSummary({
  totals,
  recipe,
}: {
  totals: CalculateTotalsResult | null;
  recipe: RecipeOut;
}) {
  if (!totals) return null;
  const summary: RecipeSummaryData = {
    price: totals.price,
    weight: totals.weight,
    nutrients: totals.nutrients,
    totalIngredients: totals.totalIngredients,
    missingByType: totals.missingByType,
    perServing: getServingBasis(recipe),
  };
  if (totals.priceUpper != null) summary.priceUpper = totals.priceUpper;
  if (totals.weightUpper != null) summary.weightUpper = totals.weightUpper;
  if (totals.nutrientsUpper) summary.nutrientsUpper = totals.nutrientsUpper;
  return (
    <EntitySummaryCard
      title="Recipe Summary"
      summaryData={{ type: "recipe", data: summary }}
    />
  );
}

function RecipeDataCharts({
  ingredients,
  totals,
}: {
  ingredients: RecipeCosting["rows"];
  totals: CalculateTotalsResult | null;
}) {
  const chart =
    ingredients.length > 0 ? (
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Cost Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <RecipeCostTreemap
              ingredients={ingredients}
              totalCost={totals?.price ?? 0}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Nutrition Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <NutritionBars ingredients={ingredients} totals={totals} />
          </CardContent>
        </Card>
      </div>
    ) : (
      <LoadingRecipeView />
    );
  return <Suspense fallback={<LoadingRecipeView />}>{chart}</Suspense>;
}

function RecipeWorkflowContent({
  recipe,
  scaledRecipe,
  viewMode,
  setViewMode,
  factor,
  setFactor,
  totals,
  missingWeightLinks,
  totalsGaps,
  wakeLock,
  tree,
  costing,
  flowLayout,
  onFlowLayoutChange,
  ingredientDataItems,
  ingredients,
  ingMap,
  nutritionNutrients,
  nutritionServingLabel,
  recipeImages,
  isDebugEnabled,
}: {
  recipe: RecipeOut;
  scaledRecipe: RecipeOut;
  viewMode: RecipeViewMode;
  setViewMode: (view: RecipeViewMode) => void;
  factor: number;
  setFactor: (factor: number) => void;
  totals: CalculateTotalsResult | null;
  missingWeightLinks: MissingWeightLink[];
  totalsGaps: React.ComponentProps<typeof RecipeTotalsCoverageButton>["gaps"];
  wakeLock: ReturnType<typeof useWakeLock>;
  tree: React.ComponentProps<typeof RecipeSpecView>["tree"] | null;
  costing: RecipeCosting | null;
  flowLayout?: RecipeFlowLayoutMode;
  onFlowLayoutChange?: (layout: RecipeFlowLayoutMode) => void;
  ingredientDataItems: RecipeCosting["rows"];
  ingredients: CostingRow[];
  ingMap: Parameters<typeof RecipeIngredientList>[0]["ingMap"];
  nutritionNutrients:
    | React.ComponentProps<typeof NutritionLabel>["nutrients"]
    | null;
  nutritionServingLabel: string;
  recipeImages: RecipeOut["images"];
  isDebugEnabled: boolean;
}) {
  const exportFormat =
    viewMode === "spec" ? "nested" : viewMode === "flow" ? "flow" : undefined;
  return (
    <Stack gap="lg">
      <RecipeWorkflowControls
        recipe={recipe}
        viewMode={viewMode}
        setViewMode={setViewMode}
        factor={factor}
        setFactor={setFactor}
        totals={totals}
        missingWeightLinks={missingWeightLinks}
        totalsGaps={totalsGaps}
        wakeLock={wakeLock}
        exportFormat={exportFormat}
      />
      <RecipeViewContent
        viewMode={viewMode}
        recipe={recipe}
        scaledRecipe={scaledRecipe}
        tree={tree}
        totals={totals}
        costing={costing}
        flowLayout={flowLayout}
        onFlowLayoutChange={onFlowLayoutChange}
        ingredientDataItems={ingredientDataItems}
        recipeImages={recipeImages}
        ingredients={ingredients}
        ingMap={ingMap}
        totalsGaps={totalsGaps}
      />
      <RecipeWorkflowSupplemental
        viewMode={viewMode}
        recipeImages={recipeImages}
        nutritionNutrients={nutritionNutrients}
        nutritionServingLabel={nutritionServingLabel}
        recipeId={recipe.id}
        isDebugEnabled={isDebugEnabled}
      />
    </Stack>
  );
}

function RecipeWorkflowControls({
  recipe,
  viewMode,
  setViewMode,
  factor,
  setFactor,
  totals,
  missingWeightLinks,
  totalsGaps,
  wakeLock,
  exportFormat,
}: {
  recipe: RecipeOut;
  viewMode: RecipeViewMode;
  setViewMode: (view: RecipeViewMode) => void;
  factor: number;
  setFactor: (factor: number) => void;
  totals: CalculateTotalsResult | null;
  missingWeightLinks: MissingWeightLink[];
  totalsGaps: React.ComponentProps<typeof RecipeTotalsCoverageButton>["gaps"];
  wakeLock: ReturnType<typeof useWakeLock>;
  exportFormat: "nested" | "flow" | undefined;
}) {
  return (
    <Row
      align="center"
      justify="between"
      wrap
      gap="sm"
      className="print:hidden"
    >
      {recipe.tags?.length ? (
        <RecipeTagList tags={recipe.tags} filterable />
      ) : null}
      <Row align="center" wrap gap="sm" className="ml-auto">
        <WakeLockButton wakeLock={wakeLock} />
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
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Open the print / export sheet"
        >
          <Printer className="size-3" />
          Print / export
        </Link>
      </Row>
    </Row>
  );
}

function WakeLockButton({
  wakeLock,
}: {
  wakeLock: ReturnType<typeof useWakeLock>;
}) {
  if (!wakeLock.supported) return null;
  const label = wakeLock.enabled
    ? "Screen stays awake while cooking — tap to allow sleep"
    : "Keep screen awake while cooking";
  return (
    <button
      type="button"
      onClick={wakeLock.toggle}
      aria-pressed={wakeLock.enabled}
      title={label}
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
  );
}

function RecipeWorkflowSupplemental({
  viewMode,
  recipeImages,
  nutritionNutrients,
  nutritionServingLabel,
  recipeId,
  isDebugEnabled,
}: {
  viewMode: RecipeViewMode;
  recipeImages: RecipeOut["images"];
  nutritionNutrients:
    | React.ComponentProps<typeof NutritionLabel>["nutrients"]
    | null;
  nutritionServingLabel: string;
  recipeId: RecipeOut["id"];
  isDebugEnabled: boolean;
}) {
  return (
    <>
      <RecipeReaderImages viewMode={viewMode} images={recipeImages} />
      {nutritionNutrients ? (
        <details className="group border border-border bg-muted/30 px-4 py-2 print:hidden">
          <summary className="cursor-pointer eyebrow marker:content-none">
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
      ) : null}
      {isDebugEnabled ? <RecipeCostingDebugCard recipeId={recipeId} /> : null}
    </>
  );
}

function RecipeReaderImages({
  viewMode,
  images,
}: {
  viewMode: RecipeViewMode;
  images: RecipeOut["images"];
}) {
  if (viewMode !== "read" || images.length <= 1) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle icon={ImageIcon}>More Images</CardTitle>
      </CardHeader>
      <CardContent>
        <EntityImageList images={images.slice(1)} />
      </CardContent>
    </Card>
  );
}

const RecipeDetailInner: React.FC<{
  recipe: RecipeOut;
  /** Route-only sections that belong in the same canonical anchor ledger. */
  leadingSections?: DetailSection[];
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
  leadingSections = [],
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

  const sections: DetailSection[] = [
    ...leadingSections,
    {
      id: "recipe-workflow",
      title: "Recipe",
      icon: BookOpen,
      placement: "full",
      surface: "plain",
      content: (
        <RecipeWorkflowContent
          recipe={recipe}
          scaledRecipe={scaledRecipe}
          viewMode={viewMode}
          setViewMode={setViewMode}
          factor={factor}
          setFactor={setFactor}
          totals={totals}
          missingWeightLinks={missingWeightLinks}
          totalsGaps={totalsGaps}
          wakeLock={wakeLock}
          tree={tree}
          costing={costing}
          flowLayout={flowLayout}
          onFlowLayoutChange={onFlowLayoutChange}
          ingredientDataItems={ingredientDataItems}
          ingredients={ingredients}
          ingMap={ingMap ?? undefined}
          nutritionNutrients={nutritionNutrients}
          nutritionServingLabel={nutritionServingLabel}
          recipeImages={recipeImages}
          isDebugEnabled={isDebugEnabled}
        />
      ),
    },
  ];

  return <DetailSections sections={sections} rawData={recipe} />;
};

// Profiled boundary so the perf overlay can attribute the recipe-detail render
// churn (the query-streaming re-render storm) to this subtree by name.
const RecipeDetail: React.FC<React.ComponentProps<typeof RecipeDetailInner>> = (
  props,
) => (
  <PerfProfiler id="RecipeDetail">
    <RecipeDetailInner {...props} />
  </PerfProfiler>
);

export default RecipeDetail;
