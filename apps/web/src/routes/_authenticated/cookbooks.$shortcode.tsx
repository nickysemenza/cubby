import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, RefreshCw, Trash } from "lucide-react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { useCookbookDelete } from "~/app/cookbooks/use-cookbook-delete";
import { RecipeList } from "~/app/recipes/recipelist";
import { Row } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Image } from "~/components/ui/image";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { entityFilterSearchFields } from "~/entities/filter-manifest";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTabParam } from "~/hooks/useTabParam";
import { useTRPC, useTRPCClient } from "~/integrations/trpc/react";
import {
  invalidateTRPCQueries,
  recipeMutationInvalidateKeys,
} from "~/lib/query-keys";

const searchSchema = z.object({
  // Active tab, deep-linkable. Default ("recipes") is omitted from the URL.
  tab: z.enum(["recipes", "ingredients"]).optional().catch(undefined),
  // Embedded RecipeList mirrors sort/page to the URL (useTableState urlSync) —
  // merge so this strict schema doesn't strip those keys.
  ...tableSearchFields,
  ...entityFilterSearchFields("recipe"),
});

export const Route = createFileRoute("/_authenticated/cookbooks/$shortcode")({
  ssr: false,
  validateSearch: searchSchema,
  component: CookbookDetailPage,
});

function CookbookDetailPage() {
  // The URL carries the cookbook's public shortcode; the browse-index query
  // (already cached after navigating from /cookbooks) resolves it to the row,
  // and everything below keys on the canonical shortcode id off that row.
  const { shortcode } = Route.useParams();
  const { tab } = Route.useSearch();
  const api = useTRPC();
  const navigate = useNavigate();

  const tabs = useTabParam(tab, "recipes", (next) =>
    navigate({ to: ".", search: (prev) => ({ ...prev, tab: next }) }),
  );

  // Name + recipe count for the hero. Reuses the browse-index query, which is
  // already cached after navigating from /cookbooks; falls back gracefully.
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());
  const cookbook = cookbooks?.find((c) => c.id === shortcode);
  const cookbookId = cookbook?.id;
  const name = cookbook?.book ?? "Cookbook";
  const recipeCount = cookbook?.recipeCount;
  const coverUrl = cookbook?.coverUrl ?? null;
  // How many recipes in the stored extraction aren't imported yet (gates the
  // "Add from source" entry into the selective re-importer).
  const notImported = cookbook
    ? Math.max(cookbook.sourceRecipeCount - cookbook.recipeCount, 0)
    : 0;

  useDocumentTitle(`Cookbook: ${name}`);

  // Reprocess streams progress server-side (one request) via useBulkStream. The
  // RefreshCw button drives it; a live bar shows beneath the hero while it runs.
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const reprocess = useBulkStream<
    never,
    { reprocessed: number; importableExtras: string[] }
  >();
  // Takes the id rather than closing over it: this is declared above the
  // "not resolved yet" guard below, where `cookbookId` is still optional.
  const runReprocess = (id: CookbookShortcode) =>
    reprocess.start(
      () => client.recipe.reprocessCookbook.mutate({ cookbookId: id }),
      {
        successToast: ({ reprocessed, importableExtras }) => {
          const extra =
            importableExtras.length > 0
              ? ` (${importableExtras.length} more in the source not yet imported)`
              : "";
          return `Reprocessed ${reprocessed} recipe${reprocessed === 1 ? "" : "s"} from ${name}${extra}`;
        },
        onDone: () => {
          invalidateTRPCQueries(queryClient, recipeMutationInvalidateKeys);
        },
      },
    );

  const { requestDelete, dialog: deleteDialog } = useCookbookDelete({
    onDeleted: () => void navigate({ to: "/cookbooks" }),
  });

  // Author + recipe count read as the spec-plate ledger stats; the cover plate
  // rides above the tabs (the spec-plate hero has no cover slot of its own).
  const heroStats: DetailHeroStat[] = [
    ...(cookbook && cookbook.author.length > 0
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

  // The id only exists once the browse index has resolved this shortcode. It
  // gates the body rather than the hooks above, so hook order stays stable
  // across the loading → loaded transition.
  if (!cookbookId) {
    return (
      <Page variant="list" title={name} entity="cookbook" compact>
        {cookbooks ? (
          <Empty>
            <EmptyTitle>Cookbook not found</EmptyTitle>
            <EmptyDescription>
              No cookbook matches the code {shortcode}.
            </EmptyDescription>
          </Empty>
        ) : null}
      </Page>
    );
  }

  return (
    <Page
      variant="detail"
      title={name}
      entity="cookbook"
      heroStats={heroStats}
      fullWidth
      actions={
        <Row align="center" gap="sm">
          {notImported > 0 && (
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
          )}
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
            onClick={() => requestDelete({ id: cookbookId, name, recipeCount })}
          >
            <Trash className="mr-2 size-4" />
            Delete cookbook
          </Button>
        </Row>
      }
    >
      {coverUrl && (
        <figure className="my-0 mb-4 w-fit shrink-0 rounded-sm border border-[var(--border)] bg-card p-2">
          <Image src={coverUrl} alt={name} className="h-24 w-16 object-cover" />
        </figure>
      )}

      {reprocess.running && (
        <BulkProgressBar
          verb="Reprocessing"
          progress={reprocess.progress}
          className="mt-4"
        />
      )}

      <Tabs
        value={tabs.value}
        onValueChange={tabs.onValueChange}
        className="mt-2"
      >
        <TabsList variant="line">
          <TabsTrigger value="recipes">Recipes</TabsTrigger>
          <TabsTrigger value="ingredients">Ingredients</TabsTrigger>
        </TabsList>
        <TabsContent value="recipes">
          {/* cookbookIdFilter pins this table to one cookbook via extraFilters,
              which wins over the manifest-derived filters — so the Source
              column's control must be hidden here, or picking a cookbook there
              would be interactive but inert (silently clobbered by the scope). */}
          <RecipeList
            cookbookIdFilter={cookbookId}
            hiddenFilterColumns={["source"]}
          />
        </TabsContent>
        <TabsContent value="ingredients">
          <IngredientUsagePanel cookbookId={cookbookId} />
        </TabsContent>
      </Tabs>

      {deleteDialog}
    </Page>
  );
}
