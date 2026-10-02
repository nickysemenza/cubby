import { useState } from "react";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { AttachExistingImageDialog } from "~/features/images/attach-existing-image-dialog";
import { ImageAssociationLinks } from "~/features/images/image-associations";
import { ImageDetailMedia } from "~/features/images/image-detail";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";

import { ImageProcessingPanel } from "./image-processing-panel";

/**
 * The image itself and every record it is attached to. The media lives here
 * rather than in the hero because an image owns no gallery of its own —
 * the record IS the picture.
 */
export const ImageAssociations: DetailSlotComponent<"image"> = ({
  record: image,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="md">
      <ImageDetailMedia image={image} />
      <ImageProcessingPanel image={image} />
      <Button variant="outline" onClick={() => setOpen(true)}>
        Attach to record
      </Button>
      {image.associations.length > 0 ? (
        <ImageAssociationLinks associations={image.associations} showRole />
      ) : (
        <Description>This image is not attached to a record.</Description>
      )}
      {open && (
        <AttachExistingImageDialog
          image={image}
          onClose={() => setOpen(false)}
        />
      )}
    </Stack>
  );
};
