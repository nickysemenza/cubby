import { type FunctionComponent, useState } from "react";

import type { CollectionActionProps } from "~/entity/entity-detail/detail-hooks";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-hooks";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { AttachExistingImageDialog } from "~/features/images/attach-existing-image-dialog";
import { ImageDetailMedia } from "~/features/images/image-detail";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { ImageProcessingPanel } from "./image-processing-panel";

/**
 * The image itself and every record it is attached to. The media lives here rather than in the
 * hero because an image owns no gallery of its own — the record IS the picture. The attachments
 * are the server's report.
 */
export const ImageAssociations: DetailSlotComponent<"image"> = ({
  record: image,
}) => (
  <Stack gap="md">
    <ImageDetailMedia image={image} />
    <ImageProcessingPanel image={image} />
    <EntityReportSlot slot="image.associations" id={image.id} record={image} />
  </Stack>
);

/** Attach action of the associations report. */
export const AttachImageAction: FunctionComponent<
  CollectionActionProps<"image">
> = ({ record: image }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Attach to record
      </Button>
      {open && (
        <AttachExistingImageDialog
          image={image}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};
