import { unsafeProductId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { DetailView } from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.product.getByID.queryOptions({ id: unsafeProductId(id) }),
  );
  const p = q.data;

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      imageUrl={p?.images[0]?.url}
      title={p?.name}
      subtitle={p?.manufacturer}
      rows={[
        { label: "UPC", value: p?.upc },
        { label: "Model", value: p?.model },
        { label: "Price", value: p?.price != null ? `$${p.price}` : null },
        { label: "Notes", value: p?.notes },
      ]}
    />
  );
}
