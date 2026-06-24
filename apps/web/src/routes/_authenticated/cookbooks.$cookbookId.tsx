import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, RefreshCw, Trash } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { RecipeList } from "~/app/recipes/recipelist";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTabParam } from "~/hooks/useTabParam";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC, useTRPCClient } from "~/trpc/react";

const searchSchema = z.object({
  // Active tab, deep-linkable. Default ("recipes") is omitted from the URL.
  tab: z.enum(["recipes", "ingredients"]).optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/cookbooks/$cookbookId")({
  ssr: false,
  validateSearch: searchSchema,
  // Brand the path param at the boundary so `useParams().cookbookId` is a
  // `CookbookId` throughout (it's compared against branded ids and passed to
  // branded filters), instead of casting inside the component.
  params: {
    parse: (raw) => ({ cookbookId: unsafeCookbookId(raw.cookbookId) }),
    stringify: (params) => ({ cookbookId: params.cookbookId }),
  },
  component: CookbookDetailPage,
});

function CookbookDetailPage() {
  // Cookbooks are keyed by their stable FK id (rename-safe), so the route param
  // is the cookbook id; the display name comes from the browse-index query.
  const cookbookId = Route.useParams().cookbookId;
  const { tab } = Route.useSearch();
  const api = useTRPC();
  const navigate = useNavigate();
  const [showDelete, setShowDelete] = useState(false);

  const tabs = useTabParam(tab, "recipes", (next) =>
    navigate({ to: ".", search: (prev) => ({ ...prev, tab: next }) }),
  );

  // Name + recipe count for the hero. Reuses the browse-index query, which is
  // already cached after navigating from /cookbooks; falls back gracefully.
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());
  const cookbook = cookbooks?.find((c) => c.id === cookbookId);
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
  const runReprocess = () =>
    reprocess.start(
      () => client.recipe.reprocessCookbook.mutate({ cookbookId }),
      {
        successToast: ({ reprocessed, importableExtras }) => {
          const extra =
            importableExtras.length > 0
              ? ` (${importableExtras.length} more in the source not yet imported)`
              : "";
          return `Reprocessed ${reprocessed} recipe${reprocessed === 1 ? "" : "s"} from ${name}${extra}`;
        },
        onDone: () => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.recipe.list,
          });
        },
      },
    );

  const deleteMutation = useActionMutation({
    mutationFn: api.recipe.deleteByCookbook.mutationOptions,
    success: ({ deleted }) =>
      `Deleted ${deleted} recipe${deleted === 1 ? "" : "s"} from ${name}`,
    invalidateKeys: [queryKeys.recipe.list, queryKeys.recipe.listCookbooks],
    onSuccess: () => {
      void navigate({ to: "/cookbooks" });
    },
    error: (err) => getErrorMessage(err) || "Failed to delete cookbook recipes",
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

  return (
    <Page
      variant="detail"
      title={name}
      entity="cookbook"
      heroStats={heroStats}
      fullWidth
      actions={
        <div className="flex items-center gap-2">
          {notImported > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigate({
                  to: "/recipes/import-cookbook",
                  search: { from: cookbookId },
                })
              }
              title="Selectively import recipes from this cookbook's source (no AI)"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add from source ({notImported})
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runReprocess()}
            disabled={reprocess.running}
            title="Re-derive recipes from the stored extraction (no AI)"
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${reprocess.running ? "animate-spin" : ""}`}
            />
            Reprocess
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDelete(true)}
          >
            <Trash className="mr-2 h-4 w-4" />
            Delete all recipes
          </Button>
        </div>
      }
    >
      {coverUrl && (
        <figure className="my-0 mb-3 w-fit shrink-0 rounded-sm border border-border bg-card p-1.5">
          <Image src={coverUrl} alt={name} className="h-24 w-16 object-cover" />
        </figure>
      )}

      {reprocess.running && (
        <BulkProgressBar
          verb="Reprocessing"
          progress={reprocess.progress}
          className="mt-3"
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
          <RecipeList cookbookIdFilter={cookbookId} />
        </TabsContent>
        <TabsContent value="ingredients">
          <IngredientUsagePanel cookbookId={cookbookId} />
        </TabsContent>
      </Tabs>

      <BulkActionDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        items={[{ id: cookbookId, name }]}
        itemNoun="cookbook"
        action="Delete"
        variant="destructive"
        pendingLabel="Deleting..."
        description={`This will permanently remove cookbook from your workspace. This action cannot be undone.`}
        onSubmit={async () => {
          await deleteMutation.mutateAsync({ cookbookId });
          setShowDelete(false);
        }}
        isPending={deleteMutation.isPending}
        renderItem={() =>
          `Every recipe from "${name}" will be permanently deleted.`
        }
      />
    </Page>
  );
}
