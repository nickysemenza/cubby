import type { RecipeOut } from "@cubby/schemas/recipe";
import { BookOpenIcon as BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import { GitBranchIcon as GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GridNineIcon as Grid3x3 } from "@phosphor-icons/react/dist/csr/GridNine";
import { ListChecksIcon as ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PrinterIcon as Printer } from "@phosphor-icons/react/dist/csr/Printer";
import { TreeViewIcon as ListTree } from "@phosphor-icons/react/dist/csr/TreeView";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { useRecipeCostingData } from "~/app/_components/hooks/useRecipeCostingData";
import { CopyDebugButton } from "~/app/_components/recipe/copy-debug-button";
import {
  buildDisplayQuantities,
  gramMapFromCosting,
} from "~/app/_components/recipe/IngredientQuantities";
import { recipeTreeToMarkdown } from "~/app/_components/recipe/recipe-export-markdown";
import { scaleRecipe } from "~/app/_components/recipe/recipe-scaling";
import { getRecipeNutritionBasis } from "~/app/_components/recipe/recipe-utils";
import { RecipeFlowView } from "~/app/_components/recipe/RecipeFlowView";
import { RecipeIngredientMatrixView } from "~/app/_components/recipe/RecipeIngredientMatrixView";
import { RecipeMagazineView } from "~/app/_components/recipe/RecipeMagazineView";
import { RecipePrepSheetView } from "~/app/_components/recipe/RecipePrepSheetView";
import { RecipeScaleControl } from "~/app/_components/recipe/RecipeScaleControl";
import { RecipeSpecView } from "~/app/_components/recipe/RecipeSpecView";
import { useRecipeTree } from "~/app/_components/recipe/useRecipeTree";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row } from "~/components/layout";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { scaleNutrition } from "~/lib/nutrition-estimates";
import { pageTitle } from "~/lib/page-title";

import { recipeExportSearchSchema } from "./-recipe-export-search";

type ExportFormat = "prep" | "read" | "nested" | "matrix" | "flow";

const FORMAT_OPTIONS: ViewSwitcherOption<ExportFormat>[] = [
  { value: "prep", label: "Prep sheet", icon: ListChecks },
  { value: "read", label: "Read", icon: BookOpen },
  { value: "nested", label: "Spec", icon: ListTree },
  { value: "matrix", label: "Matrix", icon: Grid3x3 },
  { value: "flow", label: "Flow", icon: GitBranch },
];

const searchDefaults = {
  format: undefined,
  scale: undefined,
  nutritionBasis: undefined,
} as const;

export const Route = createFileRoute(
  "/_authenticated/recipes/$shortcode_/export",
)({
  validateSearch: recipeExportSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      entityDetailFor("recipe").queryOptions(params.shortcode),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`${params.shortcode} — export`) }],
  }),
  component: RecipeExportPage,
});

/** Guard split — see the note on RecipeDetailPage in recipes.$shortcode.tsx. */
function RecipeExportPage() {
  const { shortcode } = Route.useParams();
  const { data: recipe } = useSuspenseQuery(
    entityDetailFor("recipe").queryOptions(shortcode),
  );
  if (!recipe) return null;
  return <RecipeExportBody recipe={recipe} />;
}

function RecipeExportBody({ recipe }: { recipe: RecipeOut }) {
  const { shortcode } = Route.useParams();
  const { format: rawFormat, scale, nutritionBasis } = Route.useSearch();
  const navigate = useNavigate();
  const [flowReady, setFlowReady] = useState(false);
  const handleFlowReadyChange = useCallback((ready: boolean) => {
    setFlowReady(ready);
  }, []);

  useDetailTitle(shortcode, `${recipe.name} — export`);

  const format: ExportFormat = rawFormat ?? "prep";
  const factor = scale ?? 1;

  const scaledRecipe = useMemo(
    () => scaleRecipe(recipe, factor),
    [recipe, factor],
  );
  const recipesForData = useMemo(() => [recipe], [recipe]);
  const { ingMap, recipeMap } = useRecipeCostingData(recipesForData);
  const { tree, costingById } = useRecipeTree(
    scaledRecipe,
    ingMap,
    recipeMap,
    format !== "flow",
  );
  const rootCosting = costingById?.get(recipe.id) ?? null;
  const totals = rootCosting?.totals ?? null;
  const nutritionView = getRecipeNutritionBasis(recipe, nutritionBasis, factor);

  const setFormat = (next: ExportFormat) =>
    navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        format: next === "prep" ? undefined : next,
      }),
    });
  const setScale = (f: number) =>
    navigate({
      to: ".",
      search: (prev) => ({ ...prev, scale: f === 1 ? undefined : f }),
    });

  const getMarkdown = () =>
    format !== "flow" && format !== "read" && tree
      ? recipeTreeToMarkdown(tree, {
          flavor: format,
          quantityText: (node, row) => {
            // Both prep and nested render full-batch (native) amounts.
            const gramById = gramMapFromCosting(node.costing);
            return buildDisplayQuantities(row.row, gramById)
              .map((q) => q.text)
              .join(" / ");
          },
        })
      : "";

  return (
    <Page variant="bare">
      <div className="mx-auto max-w-3xl">
        <Row align="center" gap="sm" wrap className="mb-4 print:hidden">
          <ViewSwitcher
            ariaLabel="Export format"
            options={FORMAT_OPTIONS}
            value={format}
            onValueChange={setFormat}
          />
          <RecipeScaleControl
            recipe={recipe}
            totals={totals}
            missingWeightLinks={[]}
            factor={factor}
            onFactorChange={setScale}
          />
          <Row align="center" gap="sm" className="ml-auto">
            {format !== "flow" && format !== "read" && (
              <CopyDebugButton
                getText={getMarkdown}
                label="Copy Markdown"
                toastLabel="Copied markdown"
                title="Copy this sheet as Markdown"
              />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              disabled={format === "flow" && !flowReady}
            >
              <Printer className="mr-2 size-4" />
              Print
            </Button>
          </Row>
        </Row>

        {format === "read" ? (
          <RecipeMagazineView
            recipe={scaledRecipe}
            totals={totals}
            costing={rootCosting}
            nutrition={
              totals
                ? scaleNutrition(
                    totals.estimates.nutrition,
                    nutritionView.factor,
                  )
                : null
            }
            nutritionBasisLabel={nutritionView.label}
            nutritionFactor={nutritionView.factor}
          />
        ) : format === "flow" ? (
          <RecipeFlowView
            recipe={recipe}
            scaledRecipe={scaledRecipe}
            layout="table"
            onReadyChange={handleFlowReadyChange}
          />
        ) : tree ? (
          format === "prep" ? (
            <RecipePrepSheetView tree={tree} hideGrid />
          ) : format === "matrix" ? (
            <RecipeIngredientMatrixView tree={tree} />
          ) : (
            <RecipeSpecView tree={tree} variant="export" />
          )
        ) : (
          <div className="h-[300px]">
            <SimpleLoading />
          </div>
        )}
      </div>
    </Page>
  );
}
