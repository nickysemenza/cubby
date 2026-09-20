import { useState } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { AttachExistingImageDialog } from "~/app/_components/images/attach-existing-image-dialog";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { ImageDetailMedia } from "~/app/_components/images/image-detail";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";

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
