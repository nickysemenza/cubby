import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function LocationsScreen() {
  const trpc = useTRPC();
  const q = useQuery(
    trpc.location.list.queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 1000 },
    }),
  );

  return (
    <EntityListScreen
      embedded
      title="Locations"
      items={q.data?.items ?? []}
      count={q.data?.meta.totalCount}
      isLoading={q.isLoading}
      isRefetching={q.isRefetching}
      error={q.error}
      onRefresh={() => void q.refetch()}
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
