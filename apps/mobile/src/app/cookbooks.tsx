import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function CookbooksScreen() {
  const trpc = useTRPC();
  // listCookbooks returns a plain array (not a paginated {items, meta}).
  const q = useQuery(trpc.recipe.listCookbooks.queryOptions());

  return (
    <EntityListScreen
      embedded
      title="Cookbooks"
      items={q.data ?? []}
      count={q.data?.length}
      isLoading={q.isLoading}
      isRefetching={q.isRefetching}
      error={q.error}
      onRefresh={() => void q.refetch()}
      keyExtractor={(c) => c.id}
      primaryText={(c) => c.book}
      secondaryText={(c) => c.author.join(", ")}
      imageUrl={(c) => c.coverUrl}
      rightValues={(c) => [
        `${c.recipeCount} recipe${c.recipeCount === 1 ? "" : "s"}`,
      ]}
      onPressItem={(c) =>
        router.push({
          pathname: "/cookbook/[id]",
          params: { id: c.id, name: c.book },
        })
      }
      emptyText="No cookbooks yet."
    />
  );
}
