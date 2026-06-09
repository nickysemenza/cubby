import { useQuery } from "@tanstack/react-query";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function LocationsScreen() {
  const trpc = useTRPC();
  const q = useQuery(trpc.location.list.queryOptions({ filters: {} }));

  return (
    <EntityListScreen
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
      emptyText="No locations yet."
    />
  );
}
