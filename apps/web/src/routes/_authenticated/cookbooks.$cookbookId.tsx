import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BookOpen, Plus, RefreshCw, Trash } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RecipeList } from "~/app/recipes/recipelist";
import { DeleteEntityDialog } from "~/components/dialogs/delete-entity-dialog";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { PageHero } from "~/components/layouts/page-hero";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/cookbooks/$cookbookId")({
  ssr: false,
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
  const api = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showDelete, setShowDelete] = useState(false);

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

  const reprocessMutation = useMutation(
    api.recipe.reprocessCookbook.mutationOptions({
      onSuccess: ({ reprocessed, importableExtras }) => {
        const extra =
          importableExtras.length > 0
            ? ` (${importableExtras.length} more in the source not yet imported)`
            : "";
        toast.success(
          `Reprocessed ${reprocessed} recipe${reprocessed === 1 ? "" : "s"} from ${name}${extra}`,
        );
        void queryClient.invalidateQueries({
          queryKey: [queryKeys.recipe.list],
        });
      },
      onError: (err) => {
        toast.error(err.message || "Failed to reprocess cookbook");
      },
    }),
  );

  const deleteMutation = useMutation(
    api.recipe.deleteByCookbook.mutationOptions({
      onSuccess: ({ deleted }) => {
        toast.success(
          `Deleted ${deleted} recipe${deleted === 1 ? "" : "s"} from ${name}`,
        );
        void queryClient.invalidateQueries({
          queryKey: [queryKeys.recipe.list],
        });
        void queryClient.invalidateQueries({
          queryKey: [queryKeys.recipe.listCookbooks],
        });
        void navigate({ to: "/cookbooks" });
      },
      onError: (err) => {
        toast.error(err.message || "Failed to delete cookbook recipes");
      },
    }),
  );

  return (
    <PageWrapper fullWidth>
      <div className="flex items-start gap-4">
        {coverUrl && (
          <figure className="my-0 shrink-0 rounded-sm border border-border bg-card p-1.5">
            <Image
              src={coverUrl}
              alt={name}
              className="h-24 w-16 object-cover"
            />
          </figure>
        )}
        <div className="min-w-0 flex-1">
          <PageHero
            variant="detail"
            title={name}
            entity="cookbook"
            eyebrow="Cookbook"
            meta={[
              ...(cookbook && cookbook.author.length > 0
                ? [{ label: cookbook.author.join(", ") }]
                : []),
              ...(recipeCount !== undefined
                ? [
                    {
                      icon: BookOpen,
                      label: `${recipeCount} ${recipeCount === 1 ? "recipe" : "recipes"}`,
                    },
                  ]
                : []),
            ]}
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
                  onClick={() => reprocessMutation.mutate({ cookbookId })}
                  disabled={reprocessMutation.isPending}
                  title="Re-derive recipes from the stored extraction (no AI)"
                >
                  <RefreshCw
                    className={`mr-2 h-4 w-4 ${reprocessMutation.isPending ? "animate-spin" : ""}`}
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
          />
        </div>
      </div>

      <RecipeList cookbookIdFilter={cookbookId} />

      <DeleteEntityDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        items={[{ id: cookbookId, name }]}
        entityType="cookbook"
        onDelete={async () => {
          await deleteMutation.mutateAsync({ cookbookId });
        }}
        isPending={deleteMutation.isPending}
        renderItem={() =>
          `Every recipe from "${name}" will be permanently deleted.`
        }
      />
    </PageWrapper>
  );
}
