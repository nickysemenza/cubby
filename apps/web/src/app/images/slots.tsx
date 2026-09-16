import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { ImageDetailMedia } from "~/app/_components/images/image-detail";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";

/**
 * The image itself and every record it is attached to. The media lives here
 * rather than in the hero because an image owns no gallery of its own —
 * the record IS the picture.
 */
export const ImageAssociations: DetailSlotComponent<"image"> = ({
  record: image,
}) => (
  <Stack gap="md">
    <ImageDetailMedia image={image} />
    {image.associations.length > 0 ? (
      <ImageAssociationLinks associations={image.associations} showRole />
    ) : (
      <Description>This image is not attached to a record.</Description>
    )}
  </Stack>
);
