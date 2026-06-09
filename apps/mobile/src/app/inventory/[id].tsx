import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import { formatCurrency } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { AddPhotoButton } from "@/components/add-photo-button";
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
    <>
      {item ? (
        <Stack.Screen
          options={{
            headerRight: () => (
              <AddPhotoButton
                productId={item.product.id}
                onUploaded={() => void q.refetch()}
              />
            ),
          }}
        />
      ) : null}
      <DetailView
        isLoading={q.isLoading}
        error={q.error}
        imageUrls={p?.images.map((i) => i.url)}
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
              item?.valuation != null ? formatCurrency(item.valuation) : null,
          },
          { label: "Manufacturer", value: p?.manufacturer },
          { label: "Category", value: p?.category },
          { label: "UPC", value: p?.upc },
          {
            label: "Unit price",
            value: p?.price != null ? formatCurrency(p.price) : null,
          },
        ]}
      />
    </>
  );
}
