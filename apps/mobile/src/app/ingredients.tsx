import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPCClient } from "@/lib/trpc";
import { useInfiniteList } from "@/lib/use-infinite-list";

export default function IngredientsScreen() {
  const client = useTRPCClient();
  const list = useInfiniteList({
    queryKey: ["ingredient", "list"],
    pageSize: 30,
    fetchPage: (pageIndex, pageSize) =>
      client.ingredient.list.query({
        filters: {},
        pagination: { pageIndex, pageSize },
      }),
  });

  return (
    <EntityListScreen
      embedded
      title="Ingredients"
      items={list.items}
      count={list.totalCount}
      isLoading={list.isLoading}
      isRefetching={list.isRefetching}
      error={list.error}
      onRefresh={list.refetch}
      onEndReached={list.onEndReached}
      isFetchingMore={list.isFetchingMore}
      keyExtractor={(i) => i.id}
      primaryText={(i) => i.name}
      onPressItem={(i) => router.push(`/ingredient/${i.id}`)}
      emptyText="No ingredients yet."
    />
  );
}
