import { unsafeLocationId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { DetailView } from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";

export default function LocationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.location.getByID.queryOptions({ id: unsafeLocationId(id) }),
  );
  const loc = q.data;

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      imageUrl={loc?.images[0]?.url}
      title={loc?.name}
      subtitle={loc?.type}
      rows={[
        {
          label: "Items",
          value:
            loc?.totalItemCount != null ? String(loc.totalItemCount) : null,
        },
      ]}
    />
  );
}
