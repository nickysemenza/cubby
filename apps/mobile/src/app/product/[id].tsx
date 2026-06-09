import { unsafeProductId } from "@cubby/schemas/identifiers";
import { formatCurrency } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { AddPhotoButton } from "@/components/add-photo-button";
import { DetailView } from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";
import { useDeleteEntityImage } from "@/lib/use-delete-image";

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.product.getByID.queryOptions({ id: unsafeProductId(id) }),
  );
  const p = q.data;
  const onDeleteImage = useDeleteEntityImage("PRODUCT", id, () => {
    void q.refetch();
  });

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <AddPhotoButton
              entityType="PRODUCT"
              entityId={id}
              onUploaded={() => void q.refetch()}
            />
          ),
        }}
      />
      <DetailView
        isLoading={q.isLoading}
        error={q.error}
        images={p?.images.map((i) => ({ id: i.id, url: i.url }))}
        onDeleteImage={onDeleteImage}
        title={p?.name}
        subtitle={p?.manufacturer}
        rows={[
          { label: "Category", value: p?.category },
          {
            label: "Price",
            value: p?.price != null ? formatCurrency(p.price) : null,
          },
          { label: "UPC", value: p?.upc },
          { label: "Model", value: p?.model },
          { label: "Shortcode", value: p?.shortcode },
          { label: "Notes", value: p?.notes },
        ]}
      />
    </>
  );
}
