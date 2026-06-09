import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function ProductsScreen() {
  const trpc = useTRPC();
  const q = useQuery(trpc.product.list.queryOptions({ filters: {} }));

  return (
    <EntityListScreen
      embedded
      title="Products"
      items={q.data?.items ?? []}
      count={q.data?.meta.totalCount}
      isLoading={q.isLoading}
      isRefetching={q.isRefetching}
      error={q.error}
      onRefresh={() => void q.refetch()}
      keyExtractor={(i) => i.id}
      primaryText={(i) => i.name}
      secondaryText={(i) => i.manufacturer}
      imageUrl={(i) => i.images[0]?.url}
      onPressItem={(i) => router.push(`/product/${i.id}`)}
      emptyText="No products yet."
    />
  );
}
