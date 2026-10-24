import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";

import { EntityCover } from "~/entity/components/entity-cover";
import { ROW_DENSITY } from "~/ui/data-table/density";

interface ImageThumbnailProps {
  images: Array<ImageUrlSummary & { id?: string; filename?: string }>;
  alt?: string;
  lazyPreview?: boolean;
  /** When provided, shows a colored entity icon instead of a generic image icon */
  entity?: Entity;
}

/** Image thumbnail that fills the cell height (cell must have h-px trick). */
export const ImageThumbnail = ({
  images,
  alt = "Image",
  lazyPreview = false,
  entity,
}: ImageThumbnailProps) => {
  return (
    <div className="flex h-full items-center justify-center">
      <EntityCover
        images={images}
        alt={alt}
        entity={entity}
        preview
        lazyPreview={lazyPreview}
        size={ROW_DENSITY.rowHeight}
        className="thumbnail-ring"
      />
    </div>
  );
};
