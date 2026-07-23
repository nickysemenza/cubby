import type { Entity } from "@cubby/schemas/entity";
import { ImageIcon } from "lucide-react";
import { ImageWithPreview } from "~/components/ui/image-with-preview";
import { EntityIcon } from "~/entities/entities";

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
  // Same tile for both "no image" and "image failed to load" so a broken URL
  // degrades to the entity's colored mark, never the browser's broken glyph.
  const fallbackIcon = entity ? (
    <EntityIcon entity={entity} colored className="size-4" />
  ) : (
    <ImageIcon className="size-4 text-muted-foreground/30" />
  );

  if (images.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex aspect-square h-full items-center justify-center rounded-lg bg-muted/30">
          {fallbackIcon}
        </div>
      </div>
    );
  }

  const image = images[0]!;

  return (
    <div className="flex h-full items-center justify-center">
      <div className="thumbnail-ring relative aspect-square h-full overflow-hidden rounded-lg">
        <ImageWithPreview
          src={image.url}
          alt={alt}
          lazyPreview={lazyPreview}
          fallback={fallbackIcon}
          displayWidth={64}
          previewSize={400}
          fit="contain"
          className="absolute inset-0 h-full w-full rounded-none border-0"
        />
        {images.length > 1 && (
          <div className="absolute right-0 bottom-0 flex size-3 items-center justify-center bg-black/70 text-3xs text-white">
            +{images.length - 1}
          </div>
        )}
      </div>
    </div>
  );
};
