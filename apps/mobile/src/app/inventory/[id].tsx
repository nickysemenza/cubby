import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { DetailView } from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";

export default function InventoryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.inventory.getByID.queryOptions({ id: unsafeInventoryId(id) }),
  );
  const item = q.data;

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      imageUrl={item?.product.images[0]?.url}
      title={item?.product.name}
      subtitle={item?.location.name}
      rows={[
        { label: "Manufacturer", value: item?.product.manufacturer },
        { label: "UPC", value: item?.product.upc },
      ]}
    />
  );
}
