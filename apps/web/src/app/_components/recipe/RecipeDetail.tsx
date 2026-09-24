import type { RecipeOut } from "@cubby/schemas/recipe";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { BowlFoodIcon } from "@phosphor-icons/react/dist/csr/BowlFood";
import { ClipboardTextIcon } from "@phosphor-icons/react/dist/csr/ClipboardText";
import { CoffeeIcon } from "@phosphor-icons/react/dist/csr/Coffee";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PrinterIcon } from "@phosphor-icons/react/dist/csr/Printer";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import { Link } from "@tanstack/react-router";
import type React from "react";
import { lazy, Suspense, useMemo, useState } from "react";
import { match } from "ts-pattern";

import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  ChoiceSwitcher,
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useDebug } from "~/hooks/useDebug";
import { useWakeLock } from "~/hooks/useWakeLock";
import { scaleNutrition } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";
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

import EntityImageList from "../EntityImageList";
import { useRecipeCostingData } from "../hooks/useRecipeCostingData";
import { NutritionLabel } from "../nutrition/NutritionLabel";
import { RecipeCostingDebugCard } from "./recipe-costing-debug-card";
import { scaleRecipe } from "./recipe-scaling";
import { RecipeTagList } from "./recipe-tag";
import { getIngredientName, getRecipeNutritionBasis } from "./recipe-utils";
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
  { value: "read", label: "Read", icon: BookOpenIcon },
  { value: "spec", label: "Spec", icon: ClipboardTextIcon },
  { value: "data", label: "Data", icon: TableIcon },
  { value: "prep", label: "Prep", icon: ListChecksIcon },
  { value: "flow", label: "Flow", icon: GitBranchIcon },
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
  nutrition,
  nutritionBasisLabel,
  nutritionFactor,
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
  nutrition: React.ComponentProps<typeof NutritionLabel>["estimates"] | null;
  nutritionBasisLabel: string;
  nutritionFactor: number;
}) {
  if (viewMode === "read")
    return (
      <RecipeMagazineView
        recipe={scaledRecipe}
        totals={totals}
        costing={costing}
        nutrition={nutrition}
        nutritionBasisLabel={nutritionBasisLabel}
        nutritionFactor={nutritionFactor}
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
      totalsGaps={totalsGaps}
      recipeShortcode={recipe.id}
      nutrition={nutrition}
      nutritionBasisLabel={nutritionBasisLabel}
      nutritionFactor={nutritionFactor}
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
  totalsGaps,
  recipeShortcode,
  nutrition,
  nutritionBasisLabel,
  nutritionFactor,
}: {
  totals: CalculateTotalsResult | null;
  ingredientDataItems: RecipeCosting["rows"];
  recipeImages: RecipeOut["images"];
  ingredients: CostingRow[];
  ingMap: Parameters<typeof RecipeIngredientList>[0]["ingMap"];
  costing: RecipeCosting | null;
  totalsGaps: React.ComponentProps<typeof RecipeTotalsCoverageButton>["gaps"];
  recipeShortcode: RecipeOut["id"];
  nutrition: React.ComponentProps<typeof NutritionLabel>["estimates"] | null;
  nutritionBasisLabel: string;
  nutritionFactor: number;
}) {
  return (
    <Stack gap="lg">
      <RecipeIngredientList
        ingredients={ingredients}
        ingMap={ingMap ?? undefined}
        costing={costing}
        gaps={totalsGaps}
        recipeShortcode={recipeShortcode}
        nutritionFactor={nutritionFactor}
      />
      <RecipeSummary
        totals={totals}
        nutrition={nutrition}
        nutritionBasisLabel={nutritionBasisLabel}
      />
      <RecipeDataCharts
        ingredients={ingredientDataItems}
        totals={totals}
        nutrition={nutrition}
        nutritionBasisLabel={nutritionBasisLabel}
        nutritionFactor={nutritionFactor}
      />
      {recipeImages.length > 0 ? (
        <EntityImageList images={recipeImages} />
      ) : null}
    </Stack>
  );
}

function RecipeSummary({
  totals,
  nutrition,
  nutritionBasisLabel,
}: {
  totals: CalculateTotalsResult | null;
  nutrition: React.ComponentProps<typeof NutritionLabel>["estimates"] | null;
  nutritionBasisLabel: string;
}) {
  if (!totals) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Recipe summary</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-start gap-6">
        <div className="grid gap-1 text-sm">
          <span>
            Cost:{" "}
            {formatEstimate(
              totals.estimates.cost,
              (value) => `$${value.toFixed(2)}`,
            )}
          </span>
          <span>Weight: {Math.round(totals.weight)} g</span>
          <span>
            {totals.totalIngredients}{" "}
            {totals.totalIngredients === 1 ? "ingredient" : "ingredients"}
          </span>
        </div>
        {nutrition ? (
          <NutritionLabel
            estimates={nutrition}
            servingLabel={nutritionBasisLabel}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RecipeDataCharts({
  ingredients,
  totals,
  nutrition,
  nutritionBasisLabel,
  nutritionFactor,
}: {
  ingredients: RecipeCosting["rows"];
  totals: CalculateTotalsResult | null;
  nutrition: React.ComponentProps<typeof NutritionLabel>["estimates"] | null;
  nutritionBasisLabel: string;
  nutritionFactor: number;
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
            <NutritionBars
              ingredients={ingredients}
              nutrition={nutrition}
              basisLabel={nutritionBasisLabel}
              factor={nutritionFactor}
            />
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
  nutritionBasis,
  onNutritionBasisChange,
  hasServingBasis,
  recipeImages,
  isDebugEnabled,
  openCostingGap,
  onCostingGapOpenChange,
  costingCoverageResolved,
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
    | React.ComponentProps<typeof NutritionLabel>["estimates"]
    | null;
  nutritionServingLabel: string;
  nutritionBasis: "whole" | "serving";
  onNutritionBasisChange: (basis: "whole" | "serving") => void;
  hasServingBasis: boolean;
  recipeImages: RecipeOut["images"];
  isDebugEnabled: boolean;
  openCostingGap?: boolean;
  onCostingGapOpenChange?: (open: boolean) => void;
  costingCoverageResolved: boolean;
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
        openCostingGap={openCostingGap}
        onCostingGapOpenChange={onCostingGapOpenChange}
        costingCoverageResolved={costingCoverageResolved}
        wakeLock={wakeLock}
        exportFormat={exportFormat}
        nutritionBasis={nutritionBasis}
        onNutritionBasisChange={onNutritionBasisChange}
        hasServingBasis={hasServingBasis}
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
        nutrition={nutritionNutrients}
        nutritionBasisLabel={nutritionServingLabel}
        nutritionFactor={
          getRecipeNutritionBasis(recipe, nutritionBasis, factor).factor
        }
      />
      <RecipeWorkflowSupplemental
        viewMode={viewMode}
        recipeImages={recipeImages}
        nutritionEstimates={nutritionNutrients}
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
  openCostingGap,
  onCostingGapOpenChange,
  costingCoverageResolved,
  wakeLock,
  exportFormat,
  nutritionBasis,
  onNutritionBasisChange,
  hasServingBasis,
}: {
  recipe: RecipeOut;
  viewMode: RecipeViewMode;
  setViewMode: (view: RecipeViewMode) => void;
  factor: number;
  setFactor: (factor: number) => void;
  totals: CalculateTotalsResult | null;
  missingWeightLinks: MissingWeightLink[];
  totalsGaps: React.ComponentProps<typeof RecipeTotalsCoverageButton>["gaps"];
  openCostingGap?: boolean;
  onCostingGapOpenChange?: (open: boolean) => void;
  costingCoverageResolved: boolean;
  wakeLock: ReturnType<typeof useWakeLock>;
  exportFormat: "nested" | "flow" | undefined;
  nutritionBasis: "whole" | "serving";
  onNutritionBasisChange: (basis: "whole" | "serving") => void;
  hasServingBasis: boolean;
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
          open={openCostingGap}
          onOpenChange={onCostingGapOpenChange}
          resolved={costingCoverageResolved}
        />
        <RecipeScaleControl
          recipe={recipe}
          totals={totals}
          missingWeightLinks={missingWeightLinks}
          factor={factor}
          onFactorChange={setFactor}
        />
        {hasServingBasis ? (
          <ChoiceSwitcher
            ariaLabel="Nutrition basis"
            options={[
              { value: "whole", label: "Whole scaled recipe" },
              { value: "serving", label: "Per serving" },
            ]}
            value={nutritionBasis}
            onValueChange={onNutritionBasisChange}
          />
        ) : null}
        {/* Five labelled segments measured 395px on Linux Chromium, wider
            than a 402px phone's content box; icons keep it on one line. */}
        <ViewSwitcher
          ariaLabel="Recipe view"
          compactOnMobile
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
            nutritionBasis:
              nutritionBasis === "whole" ? undefined : nutritionBasis,
          }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Open the print / export sheet"
        >
          <PrinterIcon className="size-3" />
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
      <CoffeeIcon className="size-3.5" />
      {wakeLock.enabled ? "Awake" : "Keep awake"}
    </button>
  );
}

function RecipeWorkflowSupplemental({
  viewMode,
  recipeImages,
  nutritionEstimates,
  nutritionServingLabel,
  recipeId,
  isDebugEnabled,
}: {
  viewMode: RecipeViewMode;
  recipeImages: RecipeOut["images"];
  nutritionEstimates:
    | React.ComponentProps<typeof NutritionLabel>["estimates"]
    | null;
  nutritionServingLabel: string;
  recipeId: RecipeOut["id"];
  isDebugEnabled: boolean;
}) {
  return (
    <>
      <RecipeReaderImages viewMode={viewMode} images={recipeImages} />
      {nutritionEstimates ? (
        <details className="group border border-border bg-muted/30 px-4 py-2 print:hidden">
          <summary className="cursor-pointer eyebrow marker:content-none">
            <BowlFoodIcon className="mr-2 inline size-3 align-[-2px]" />
            Nutrition
          </summary>
          <div className="mt-4">
            <NutritionLabel
              estimates={nutritionEstimates}
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
  /** Controlled view mode (e.g. URL-driven on the detail route). */
  view?: RecipeViewMode;
  onViewChange?: (view: RecipeViewMode) => void;
  /** Controlled scale factor (URL-driven on the detail route); 1 = unscaled. */
  scale?: number;
  onScaleChange?: (factor: number) => void;
  /** Controlled nutrition basis; the route persists this beside scale/view. */
  nutritionBasis?: "whole" | "serving";
  onNutritionBasisChange?: (basis: "whole" | "serving") => void;
  flowLayout?: RecipeFlowLayoutMode;
  onFlowLayoutChange?: (layout: RecipeFlowLayoutMode) => void;
  /** Opens the live totals-gap popover for a Problems drill-down. */
  openCostingGap?: boolean;
  onCostingGapOpenChange?: (open: boolean) => void;
}> = ({
  recipe,
  view: controlledView,
  onViewChange,
  scale: controlledScale,
  onScaleChange,
  nutritionBasis: controlledNutritionBasis,
  onNutritionBasisChange,
  flowLayout,
  onFlowLayoutChange,
  openCostingGap,
  onCostingGapOpenChange,
}) => {
  // Controlled when the parent supplies view/onViewChange; otherwise self-managed
  // (e.g. the search preview panel embeds this without URL state).
  const [internalView, setInternalView] = useState<RecipeViewMode>("read");
  const [internalScale, setInternalScale] = useState(1);
  const [internalNutritionBasis, setInternalNutritionBasis] = useState<
    "whole" | "serving"
  >("whole");
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

  // A serving requires a serving count; a mass/volume yield is not a serving.
  const requestedNutritionBasis =
    controlledNutritionBasis ?? internalNutritionBasis;
  const nutritionView = getRecipeNutritionBasis(
    recipe,
    requestedNutritionBasis,
    factor,
  );
  const nutritionBasis = nutritionView.basis;
  const setNutritionBasis = onNutritionBasisChange ?? setInternalNutritionBasis;
  const nutritionServingLabel = nutritionView.label;
  const nutritionNutrients = useMemo(
    () =>
      totals
        ? scaleNutrition(totals.estimates.nutrition, nutritionView.factor)
        : null,
    [totals, nutritionView.factor],
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

  return (
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
      openCostingGap={openCostingGap}
      onCostingGapOpenChange={onCostingGapOpenChange}
      costingCoverageResolved={costing !== null && ingMap !== null}
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
      nutritionBasis={nutritionBasis}
      onNutritionBasisChange={setNutritionBasis}
      hasServingBasis={nutritionView.hasServing}
      recipeImages={recipeImages}
      isDebugEnabled={isDebugEnabled}
    />
  );
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
