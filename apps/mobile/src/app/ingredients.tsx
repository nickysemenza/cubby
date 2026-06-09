import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function IngredientsScreen() {
  const trpc = useTRPC();
  const q = useQuery(trpc.ingredient.list.queryOptions({ filters: {} }));

  return (
    <EntityListScreen
      embedded
      title="Ingredients"
      items={q.data?.items ?? []}
      count={q.data?.meta.totalCount}
      isLoading={q.isLoading}
      isRefetching={q.isRefetching}
      error={q.error}
      onRefresh={() => void q.refetch()}
      keyExtractor={(i) => i.id}
      primaryText={(i) => i.name}
      onPressItem={(i) => router.push(`/ingredient/${i.id}`)}
      emptyText="No ingredients yet."
    />
  );
}
