import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BookOpen, RefreshCw, Trash } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RecipeList } from "~/app/recipes/recipelist";
import { DeleteEntityDialog } from "~/components/dialogs/delete-entity-dialog";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { PageHero } from "~/components/layouts/page-hero";
import { Button } from "~/components/ui/button";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/cookbooks/$cookbookId")({
  ssr: false,
  component: CookbookDetailPage,
});

function CookbookDetailPage() {
  // Cookbooks are keyed by their stable FK id (rename-safe), so the route param
  // is the cookbook id; the display name comes from the browse-index query.
  const cookbookId = unsafeCookbookId(Route.useParams().cookbookId);
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
      <PageHero
        variant="detail"
        title={name}
        eyebrow="Cookbook"
        meta={
          recipeCount !== undefined
            ? [
                {
                  icon: BookOpen,
                  label: `${recipeCount} ${recipeCount === 1 ? "recipe" : "recipes"}`,
                },
              ]
            : undefined
        }
        actions={
          <div className="flex items-center gap-2">
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
