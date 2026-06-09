import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPCClient } from "@/lib/trpc";
import { useInfiniteList } from "@/lib/use-infinite-list";

export default function LocationsScreen() {
  const client = useTRPCClient();
  const list = useInfiniteList({
    queryKey: ["location", "list"],
    pageSize: 30,
    fetchPage: (pageIndex, pageSize) =>
      client.location.list.query({
        filters: {},
        pagination: { pageIndex, pageSize },
      }),
  });

  return (
    <EntityListScreen
      embedded
      title="Locations"
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
      secondaryText={(i) => i.type}
      imageUrl={(i) => i.images[0]?.url}
      rightValues={(i) => [
        i.inventoryEntries.length ? `${i.inventoryEntries.length} items` : null,
      ]}
      onPressItem={(i) => router.push(`/location/${i.id}`)}
      emptyText="No locations yet."
    />
  );
}
