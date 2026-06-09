import { formatCurrency } from "@cubby/shared";
import { router } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { SignOutButton } from "@/components/sign-out-button";
import { useTRPCClient } from "@/lib/trpc";
import { useFormattedAmounts } from "@/lib/use-formatted-amounts";
import { useInfiniteList } from "@/lib/use-infinite-list";

export default function InventoryScreen() {
  const client = useTRPCClient();
  const list = useInfiniteList({
    queryKey: ["inventory", "list"],
    pageSize: 30,
    fetchPage: (pageIndex, pageSize) =>
      client.inventory.list.query({
        filters: {},
        pagination: { pageIndex, pageSize },
      }),
  });

  // Pretty amounts ("⅓ cup", "2 - 4 each") via on-device recipebridge WASM,
  // batched in one WebView round-trip; falls back to the raw value until ready.
  const amounts = useFormattedAmounts(
    list.items,
    (i) => i.id,
    (i) => i.amount,
  );

  return (
    <EntityListScreen
      title="Inventory"
      items={list.items}
      count={list.totalCount}
      isLoading={list.isLoading}
      isRefetching={list.isRefetching}
      error={list.error}
      onRefresh={list.refetch}
      onEndReached={list.onEndReached}
      isFetchingMore={list.isFetchingMore}
      keyExtractor={(i) => i.id}
      primaryText={(i) => i.product.name}
      secondaryText={(i) =>
        [i.location.name, i.product.manufacturer].filter(Boolean).join(" · ")
      }
      imageUrl={(i) => i.product.images[0]?.url}
      rightValues={(i) => [
        amounts.get(i.id) ?? `${i.amount.value} ${i.amount.unit}`,
        i.valuation != null ? formatCurrency(i.valuation) : null,
      ]}
      onPressItem={(i) => router.push(`/inventory/${i.id}`)}
      headerRight={<SignOutButton />}
      emptyText="No inventory yet."
    />
  );
}
