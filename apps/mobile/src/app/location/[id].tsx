import { unsafeLocationId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import {
  DetailNavRow,
  DetailSection,
  DetailView,
} from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";

export default function LocationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.location.getByID.queryOptions({ id: unsafeLocationId(id) }),
  );
  const loc = q.data;
  const children = loc?.children ?? [];

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      imageUrls={loc?.images.map((i) => i.url)}
      title={loc?.name}
      subtitle={loc?.type}
      rows={[
        {
          label: "Total items",
          value:
            loc?.totalItemCount != null ? String(loc.totalItemCount) : null,
        },
        {
          label: "Direct items",
          value:
            loc?.directItemCount != null ? String(loc.directItemCount) : null,
        },
        { label: "Parent", value: loc?.parent?.name },
      ]}
    >
      {children.length ? (
        <DetailSection title={`Sub-locations (${children.length})`}>
          {children.map((c) => (
            <DetailNavRow
              key={c.id}
              label={c.name}
              sublabel={c.type}
              onPress={() => router.push(`/location/${c.id}`)}
            />
          ))}
        </DetailSection>
      ) : null}
    </DetailView>
  );
}
