import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BookOpen, Trash } from "lucide-react";
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

export const Route = createFileRoute("/_authenticated/cookbooks/$book")({
  ssr: false,
  component: CookbookDetailPage,
});

function CookbookDetailPage() {
  // TanStack Router decodes the path segment, so `book` is the raw cookbook
  // name (matches the recipes' SourceData). Book names are cleaned EPUB
  // filenames, so a literal "/" — which wouldn't round-trip as one segment — is
  // not expected in practice.
  const { book } = Route.useParams();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showDelete, setShowDelete] = useState(false);

  useDocumentTitle(`Cookbook: ${book}`);

  // Recipe count for the hero. Reuses the browse-index query, which is already
  // cached after navigating from /cookbooks; falls back gracefully otherwise.
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());
  const recipeCount = cookbooks?.find((c) => c.book === book)?.recipeCount;

  const deleteMutation = useMutation(
    api.recipe.deleteByCookbook.mutationOptions({
      onSuccess: ({ deleted }) => {
        toast.success(
          `Deleted ${deleted} recipe${deleted === 1 ? "" : "s"} from ${book}`,
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
        title={book}
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
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDelete(true)}
          >
            <Trash className="mr-2 h-4 w-4" />
            Delete all recipes
          </Button>
        }
      />

      <RecipeList bookFilter={book} />

      <DeleteEntityDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        items={[{ id: book, name: book }]}
        entityType="cookbook"
        onDelete={async () => {
          await deleteMutation.mutateAsync({ book });
        }}
        isPending={deleteMutation.isPending}
        renderItem={() =>
          `Every recipe from "${book}" will be permanently deleted.`
        }
      />
    </PageWrapper>
  );
}
