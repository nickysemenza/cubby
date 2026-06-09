import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPCClient } from "@/lib/trpc";
import { useInfiniteList } from "@/lib/use-infinite-list";

export default function RecipesScreen() {
  const client = useTRPCClient();
  const list = useInfiniteList({
    queryKey: ["recipe", "list"],
    pageSize: 30,
    fetchPage: (pageIndex, pageSize) =>
      client.recipe.list.query({
        filters: {},
        pagination: { pageIndex, pageSize },
      }),
  });

  return (
    <EntityListScreen
      title="Recipes"
      items={list.items}
      count={list.totalCount}
      isLoading={list.isLoading}
      isRefetching={list.isRefetching}
      error={list.error}
      onRefresh={list.refetch}
      onEndReached={list.onEndReached}
      isFetchingMore={list.isFetchingMore}
      keyExtractor={(i) => i.id}
      primaryText={(i) => i.name ?? "Untitled recipe"}
      secondaryText={(i) => i.tags?.join(" · ")}
      imageUrl={(i) => i.images[0]?.url}
      rightValues={(i) => [i.servings != null ? `Serves ${i.servings}` : null]}
      onPressItem={(i) => router.push(`/recipe/${i.id}`)}
      emptyText="No recipes yet."
    />
  );
}
