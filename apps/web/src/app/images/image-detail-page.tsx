import type { ImageWithEntity } from "@cubby/schemas/image";
import { useEntityDelete } from "~/app/_components/hooks/useEntityDelete";
import {
  ImageDetail,
  ImageDetailMedia,
} from "~/app/_components/images/image-detail";
import { Page } from "~/components/page/Page";
import { image } from "~/entities/image.functions";
import { formatCount } from "~/lib/utils";

export default function ImageDetailPage({
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
