import { formatCurrency } from "@cubby/shared";
import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPCClient } from "@/lib/trpc";
import { useInfiniteList } from "@/lib/use-infinite-list";

export default function ProductsScreen() {
  const client = useTRPCClient();
  const list = useInfiniteList({
    queryKey: ["product", "list"],
    pageSize: 30,
    fetchPage: (pageIndex, pageSize) =>
      client.product.list.query({
        filters: {},
        pagination: { pageIndex, pageSize },
      }),
  });

  return (
    <EntityListScreen
      embedded
      title="Products"
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
      secondaryText={(i) =>
        [i.manufacturer, i.category].filter(Boolean).join(" · ")
      }
      imageUrl={(i) => i.images[0]?.url}
      rightValues={(i) => [i.price != null ? formatCurrency(i.price) : null]}
      onPressItem={(i) => router.push(`/product/${i.id}`)}
      emptyText="No products yet."
    />
  );
}
