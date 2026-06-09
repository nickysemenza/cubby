import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function RecipesScreen() {
  const trpc = useTRPC();
  const q = useQuery(
    trpc.recipe.list.queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 1000 },
    }),
  );

  return (
    <EntityListScreen
      title="Recipes"
      items={q.data?.items ?? []}
      count={q.data?.meta.totalCount}
      isLoading={q.isLoading}
      isRefetching={q.isRefetching}
      error={q.error}
      onRefresh={() => void q.refetch()}
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
