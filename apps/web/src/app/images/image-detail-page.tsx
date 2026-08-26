import type { ImageWithEntity } from "@cubby/schemas/image";
import { useQuery } from "@tanstack/react-query";
import { useEntityDelete } from "~/app/_components/hooks/useEntityDelete";
import {
  ImageDetail,
  ImageDetailMedia,
} from "~/app/_components/images/image-detail";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { image } from "~/entities/image.functions";
import { formatCount } from "~/lib/utils";

interface ImageDetailPageProps {
  shortcode: string;
}

export default function ImageDetailPage({ shortcode }: ImageDetailPageProps) {
  const {
    data: imageDetails,
    isLoading,
    error,
  } = useQuery(image.detail.queryOptions({ id: shortcode }));

  if (isLoading) {
    return (
      <Page variant="list" title="Image details" entity="image" compact>
        <SimpleLoading text="Loading image details..." />
      </Page>
    );
  }

  if (error || !imageDetails) {
    return (
      <Page variant="list" title="Image not found" entity="image" compact>
        <div className="flex min-h-[40vh] items-center justify-center">
          <Stack gap="xs" className="text-center">
            <h2 className="font-semibold text-xl">Image not found</h2>
            <p className="mt-2 text-muted-foreground">
              The image you are looking for does not exist.
            </p>
          </Stack>
        </div>
      </Page>
    );
  }

  return <LoadedImageDetailPage imageDetails={imageDetails} />;
}

function LoadedImageDetailPage({
  imageDetails,
}: {
  imageDetails: ImageWithEntity;
}) {
  // Image deletion intentionally removes both the row and its R2 object. Keep
  // that destructive operation on the canonical record hero, not inside a
  // compact metadata card or embedded preview.
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: imageDetails.id,
    name: imageDetails.filename,
    entity: "image",
    mutationOptions: (callbacks) => ({
      ...image.delete.mutationOptions(),
      ...callbacks,
    }),
    redirectTo: "/images",
  });

  return (
    <Page
      variant="detail"
      entity="image"
      title={imageDetails.filename || "Image"}
      rawData={imageDetails}
      heroNo={imageDetails.id}
      heroStamp={{
        label: imageDetails.status,
        tone:
          imageDetails.status === "FAILED"
            ? "red"
            : imageDetails.status === "UPLOADED"
              ? "green"
              : "ink",
      }}
      heroStats={[
        {
          label: "Associations",
          value: formatCount(imageDetails.associations.length),
        },
        {
          label: "Dimensions",
          value:
            imageDetails.width && imageDetails.height
              ? `${imageDetails.width} × ${imageDetails.height}`
              : "—",
        },
      ]}
      heroMedia={<ImageDetailMedia image={imageDetails} />}
      heroActions={{ secondary: deleteButton }}
    >
      <ImageDetail image={imageDetails} />
      {deleteDialog}
    </Page>
  );
}
