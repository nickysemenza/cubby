import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { SignOutButton } from "@/components/sign-out-button";
import { useTRPC } from "@/lib/trpc";

export default function InventoryScreen() {
  const trpc = useTRPC();
  const q = useQuery(
    trpc.inventory.list.queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 1000 },
    }),
  );

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
      secondaryText={(i) =>
        [i.location.name, i.product.manufacturer].filter(Boolean).join(" · ")
      }
      imageUrl={(i) => i.product.images[0]?.url}
      rightValues={(i) => [
        `${i.amount.value} ${i.amount.unit}`,
        i.valuation != null ? `$${i.valuation.toFixed(2)}` : null,
      ]}
      onPressItem={(i) => router.push(`/inventory/${i.id}`)}
      headerRight={<SignOutButton />}
      emptyText="No inventory yet."
    />
  );
}
