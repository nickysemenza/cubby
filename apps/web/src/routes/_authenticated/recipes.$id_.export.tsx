import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Grid3x3, ListChecks, ListTree, Printer } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { useRecipeCostingData } from "~/app/_components/hooks/useRecipeCostingData";
import { CopyDebugButton } from "~/app/_components/recipe/copy-debug-button";
import {
  buildDisplayQuantities,
  gramMapFromCosting,
} from "~/app/_components/recipe/IngredientQuantities";
import { RecipeIngredientMatrixView } from "~/app/_components/recipe/RecipeIngredientMatrixView";
import { RecipePrepSheetView } from "~/app/_components/recipe/RecipePrepSheetView";
import { RecipeScaleControl } from "~/app/_components/recipe/RecipeScaleControl";
import { RecipeSpecView } from "~/app/_components/recipe/RecipeSpecView";
import { recipeTreeToMarkdown } from "~/app/_components/recipe/recipe-export-markdown";
import { scaleRecipe } from "~/app/_components/recipe/recipe-scaling";
import { useRecipeTree } from "~/app/_components/recipe/useRecipeTree";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row } from "~/components/layout";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

type ExportFormat = "prep" | "nested" | "matrix";

const FORMAT_OPTIONS: ViewSwitcherOption<ExportFormat>[] = [
  { value: "prep", label: "Prep sheet", icon: ListChecks },
  { value: "nested", label: "Spec", icon: ListTree },
  { value: "matrix", label: "Matrix", icon: Grid3x3 },
];

const searchSchema = z.object({
  format: z.enum(["prep", "nested", "matrix"]).optional().catch(undefined),
  scale: z.number().positive().optional().catch(undefined),
});

const searchDefaults = { format: undefined, scale: undefined } as const;

export const Route = createFileRoute("/_authenticated/recipes/$id_/export")({
  ssr: false,
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.recipe.getByID.queryOptions({ id: params.id }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: RecipeExportPage,
});

function RecipeExportPage() {
  const { id } = Route.useParams();
  const { format: rawFormat, scale } = Route.useSearch();
  const navigate = useNavigate();
  const api = useTRPC();

  const { data: recipe } = useSuspenseQuery(
    api.recipe.getByID.queryOptions({ id }),
  );
  useDocumentTitle(recipe.name ? `${recipe.name} — export` : undefined);

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
    true,
  );
  const totals = costingById?.get(recipe.id)?.totals ?? null;

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
    tree
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
    <PageWrapper>
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
            <CopyDebugButton
              getText={getMarkdown}
              label="Copy Markdown"
              toastLabel="Copied markdown"
              title="Copy this sheet as Markdown"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.print()}
            >
              <Printer className="mr-2 size-4" />
              Print
            </Button>
          </Row>
        </Row>

        {tree ? (
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
    </PageWrapper>
  );
}
