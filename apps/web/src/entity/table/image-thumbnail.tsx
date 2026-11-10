import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { ReactNode } from "react";

import { EntityCover } from "~/entity/components/entity-cover";
import { ROW_DENSITY } from "~/ui/data-table/density";

interface ImageThumbnailProps {
  images: Array<ImageUrlSummary & { id?: string; filename?: string }>;
  alt?: string;
  preview?: boolean;
  /** When provided, shows a colored entity icon instead of a generic image icon */
  entity?: Entity;
  /** The record's own mark, shown in place of the entity icon. */
  fallback?: ReactNode;
}

/** Image thumbnail that fills the cell height (cell must have h-px trick). */
export const ImageThumbnail = ({
  images,
  alt = "Image",
  preview = true,
  entity,
  fallback,
}: ImageThumbnailProps) => {
  // The cover's frame overhangs its cell by a pixel, so spill-over read it as
  // clipped and painted an inert copy over it that swallowed the preview.
  return (
    <div
      data-cell-spill-off=""
      className="flex h-full items-center justify-center"
    >
      <EntityCover
        images={images}
        alt={alt}
        entity={entity}
        fallback={fallback}
        preview={preview}
        size={ROW_DENSITY.rowHeight}
        className="thumbnail-ring"
      />
    </div>
  );
};
