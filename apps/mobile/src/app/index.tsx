import { useQuery } from "@tanstack/react-query";
import { EntityListScreen } from "@/components/entity-list-screen";
import { SignOutButton } from "@/components/sign-out-button";
import { useTRPC } from "@/lib/trpc";

export default function InventoryScreen() {
  const trpc = useTRPC();
  const q = useQuery(trpc.inventory.list.queryOptions({ filters: {} }));

  return (
    <EntityListScreen
      title="Inventory"
      items={q.data?.items ?? []}
      count={q.data?.meta.totalCount}
      isLoading={q.isLoading}
      isRefetching={q.isRefetching}
      error={q.error}
      onRefresh={() => void q.refetch()}
      keyExtractor={(i) => i.id}
      primaryText={(i) => i.product.name}
      secondaryText={(i) => i.location.name}
      imageUrl={(i) => i.product.images[0]?.url}
      headerRight={<SignOutButton />}
      emptyText="No inventory yet."
    />
  );
}
