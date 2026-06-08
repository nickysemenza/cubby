import { useQuery } from "@tanstack/react-query";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function RecipesScreen() {
  const trpc = useTRPC();
  const q = useQuery(trpc.recipe.list.queryOptions({ filters: {} }));

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
      emptyText="No recipes yet."
    />
  );
}
