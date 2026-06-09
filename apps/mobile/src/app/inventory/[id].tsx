import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { DetailView } from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";

export default function InventoryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.inventory.getByID.queryOptions({ id: unsafeInventoryId(id) }),
  );
  const item = q.data;
  const p = item?.product;

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      imageUrl={p?.images[0]?.url}
      title={p?.name}
      subtitle={item?.location.name}
      onTitlePress={
        item ? () => router.push(`/product/${item.product.id}`) : undefined
      }
      onSubtitlePress={
        item ? () => router.push(`/location/${item.location.id}`) : undefined
      }
      rows={[
        {
          label: "Quantity",
          value: item ? `${item.amount.value} ${item.amount.unit}` : null,
        },
        {
          label: "Value",
          value:
            item?.valuation != null ? `$${item.valuation.toFixed(2)}` : null,
        },
        { label: "Manufacturer", value: p?.manufacturer },
        { label: "Category", value: p?.category },
        { label: "UPC", value: p?.upc },
        {
          label: "Unit price",
          value: p?.price != null ? `$${p.price.toFixed(2)}` : null,
        },
      ]}
    />
  );
}
