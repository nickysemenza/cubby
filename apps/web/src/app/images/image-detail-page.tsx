import type { ImageWithEntity } from "@cubby/schemas/image";
import { EntityActionButtons } from "~/app/_components/actions/entity-actions";
import {
  ImageDetail,
  ImageDetailMedia,
} from "~/app/_components/images/image-detail";
import { Page } from "~/components/page/Page";
import { formatCount } from "~/lib/utils";

export default function ImageDetailPage({
  imageDetails,
}: {
  imageDetails: ImageWithEntity;
}) {
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
      heroActions={{
        secondary: <EntityActionButtons entity="image" record={imageDetails} />,
      }}
    >
      <ImageDetail image={imageDetails} />
    </Page>
  );
}
