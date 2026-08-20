import type { Entity } from "@cubby/schemas/entity";
import { EntityCover } from "~/components/entity/entity-cover";

interface ImageData {
  id: string;
  url: string;
  filename?: string;
}

interface ImageThumbnailProps {
  images: ImageData[];
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
        className="thumbnail-ring h-full"
      />
    </div>
  );
};
