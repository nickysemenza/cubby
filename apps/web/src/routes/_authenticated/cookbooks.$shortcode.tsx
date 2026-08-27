import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import type { CookbookSummary } from "@cubby/schemas/recipe";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { BookOpen, Link2, Plus, RefreshCw, Trash } from "lucide-react";
import { z } from "zod";
import {
  type DetailSection,
  DetailSections,
} from "~/app/_components/data-table/detail-page";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { notFoundPage } from "~/app/_components/routing/entity-routes";
import { CookbookPhysicalCopy } from "~/app/cookbooks/cookbook-physical-copy";
import { useCookbookDelete } from "~/app/cookbooks/use-cookbook-delete";
import { recipeStreams } from "~/app/recipes/recipe.functions";
import { RecipeList } from "~/app/recipes/recipelist";
import { Row } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { cookbook as cookbookOperations } from "~/entities/cookbook.functions";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTabParam } from "~/hooks/useTabParam";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { shortcodeHead } from "~/lib/page-title";

const searchSchema = z.object({
  // Active tab, deep-linkable. Default ("recipes") is omitted from the URL.
  tab: z.enum(["recipes", "ingredients"]).optional().catch(undefined),
  // Embedded RecipeList mirrors sort/page to the URL (useTableState urlSync) —
  // merge so this strict schema doesn't strip those keys.
  ...tableSearchFields,
  ...entityFilterSearchFields("recipe"),
});

const CookbookNotFound = notFoundPage(
  "cookbook",
  "Cookbook not found",
  "This cookbook is no longer available.",
);

export const Route = createFileRoute("/_authenticated/cookbooks/$shortcode")({
  validateSearch: searchSchema,
  loader: async ({ params, context }) => {
    const cookbook = await context.queryClient.ensureQueryData(
      cookbookOperations.detail.queryOptions({ shortcode: params.shortcode }),
    );
    if (!cookbook) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: CookbookNotFound,
  head: shortcodeHead,
  component: CookbookDetailPage,
});

function CookbookDetailPage() {
  const { shortcode } = Route.useParams();
  const { data: cookbook } = useSuspenseQuery(
    cookbookOperations.detail.queryOptions({ shortcode }),
  );
  // The loader establishes this before the route body mounts. Keep the guard
  // for a cache update that removes the current cookbook after navigation.
  if (!cookbook) throw notFound();

  return <CookbookDetailBody cookbook={cookbook} />;
}

function CookbookDetailBody({ cookbook }: { cookbook: CookbookSummary }) {
  const { shortcode } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate();

  const tabs = useTabParam(tab, "recipes", (next) =>
    navigate({ to: ".", search: (prev) => ({ ...prev, tab: next }) }),
  );

  const cookbookId = cookbook.id;
  const name = cookbook.book;
  const recipeCount = cookbook.recipeCount;
  const coverUrl = cookbook.coverUrl;
  // How many recipes in the stored extraction aren't imported yet (gates the
  // "Add from source" entry into the selective re-importer).
  const notImported = Math.max(
    cookbook.sourceRecipeCount - cookbook.recipeCount,
    0,
  );

  useDetailTitle(shortcode, cookbook.book);

  // Reprocess streams progress server-side (one request) via useBulkStream. The
  // RefreshCw button drives it; a live bar shows beneath the hero while it runs.
  const queryClient = useQueryClient();
  const reprocess = useBulkStream<
    never,
    { reprocessed: number; importableExtras: number }
  >();
  // Takes the id rather than closing over it: this is declared above the
  // "not resolved yet" guard below, where `cookbookId` is still optional.
  const runReprocess = (id: CookbookShortcode) =>
    reprocess.start(
      (signal) =>
        recipeStreams.reprocessCookbook.open({ cookbookId: id }, { signal }),
      {
        successToast: ({ reprocessed, importableExtras }) => {
          const extra =
            importableExtras > 0
              ? ` (${importableExtras} more in the source not yet imported)`
              : "";
          return `Reprocessed ${reprocessed} recipe${reprocessed === 1 ? "" : "s"} from ${name}${extra}`;
        },
        onDone: () => {
          void invalidateOperationTags(queryClient, ripple.recipeList);
        },
      },
    );

  const { requestDelete, dialog: deleteDialog } = useCookbookDelete({
    onDeleted: () => void navigate({ to: "/cookbooks" }),
  });

  // Author + recipe count read as the spec-plate ledger stats; the cover plate
  // rides above the tabs (the spec-plate hero has no cover slot of its own).
  const heroStats: DetailHeroStat[] = [
    ...(cookbook.author.length > 0
      ? [{ label: "Author", value: cookbook.author.join(", ") }]
      : []),
    ...(recipeCount !== undefined
      ? [
          {
            label: "Recipes",
            value: `${recipeCount} ${recipeCount === 1 ? "recipe" : "recipes"}`,
          },
        ]
      : []),
  ];

  const sections: DetailSection[] = [
    {
      id: "physical-copy",
      title: "Physical copy",
      icon: Link2,
      placement: "supporting",
      content: (
        <CookbookPhysicalCopy
          cookbookId={cookbookId}
          cookbookName={name}
          product={cookbook.product ?? null}
        />
      ),
    },
    {
      id: "cookbook",
      title: "Recipes & ingredients",
      icon: BookOpen,
      placement: "full",
      surface: "plain",
      content: (
        <div className="space-y-2">
          {reprocess.running && (
            <BulkProgressBar
              verb="Reprocessing"
              progress={reprocess.progress}
            />
          )}
          <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
            <TabsList variant="line">
              <TabsTrigger value="recipes">Recipes</TabsTrigger>
              <TabsTrigger value="ingredients">Ingredients</TabsTrigger>
            </TabsList>
            <TabsContent value="recipes">
              {/* cookbookIdFilter pins this table to one cookbook via
                  extraFilters. Its Source control stays hidden because that
                  scope deliberately outranks an in-table cookbook filter. */}
              <RecipeList
                cookbookIdFilter={cookbookId}
                hiddenFilterColumns={["source"]}
              />
            </TabsContent>
            <TabsContent value="ingredients">
              <IngredientUsagePanel cookbookId={cookbookId} />
            </TabsContent>
          </Tabs>
        </div>
      ),
    },
  ];

  return (
    <Page
      variant="detail"
      title={name}
      entity="cookbook"
      rawData={cookbook}
      heroNo={cookbook.id}
      heroStats={heroStats}
      layout="full"
      heroMedia={
        coverUrl ? (
          <div className="flex justify-center border-border border-y bg-card p-3 md:rounded-md md:border">
            <Image
              src={coverUrl}
              alt={name}
              displayWidth={480}
              className="max-h-72 w-auto object-contain"
            />
          </div>
        ) : undefined
      }
      heroActions={{
        primary:
          notImported > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigate({
                  to: "/recipes/import",
                  search: { from: cookbookId },
                })
              }
              title="Selectively import recipes from this cookbook's source (no AI)"
            >
              <Plus className="mr-2 size-4" />
              Add from source ({notImported})
            </Button>
          ) : undefined,
        secondary: (
          <Row align="center" gap="sm">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runReprocess(cookbookId)}
              disabled={reprocess.running}
              title="Re-derive recipes from the stored extraction (no AI)"
            >
              <RefreshCw
                className={`mr-2 size-4 ${reprocess.running ? "animate-spin" : ""}`}
              />
              Reprocess
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() =>
                requestDelete({ id: cookbookId, name, recipeCount })
              }
            >
              <Trash className="mr-2 size-4" />
              Delete cookbook
            </Button>
          </Row>
        ),
      }}
    >
      <DetailSections sections={sections} rawData={cookbook} />
      {deleteDialog}
    </Page>
  );
}
