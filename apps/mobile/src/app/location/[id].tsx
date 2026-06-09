import { unsafeLocationId } from "@cubby/schemas/identifiers";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { AddPhotoButton } from "@/components/add-photo-button";
import {
  DetailNavRow,
  DetailSection,
  DetailView,
} from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";
import { useDeleteEntityImage } from "@/lib/use-delete-image";

export default function LocationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.location.getByID.queryOptions({ id: unsafeLocationId(id) }),
  );
  const loc = q.data;
  const children = loc?.children ?? [];
  const onDeleteImage = useDeleteEntityImage("LOCATION", id, () => {
    void q.refetch();
  });

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <AddPhotoButton
              entityType="LOCATION"
              entityId={id}
              onUploaded={() => void q.refetch()}
            />
          ),
        }}
      />
      <DetailView
        isLoading={q.isLoading}
        error={q.error}
        images={loc?.images.map((i) => ({ id: i.id, url: i.url }))}
        onDeleteImage={onDeleteImage}
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
    </>
  );
}
