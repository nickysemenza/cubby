import type { ImageOut } from "@cubby/schemas/image";
import { publicImageUrl } from "@cubby/schemas/image-summary";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { Link } from "@tanstack/react-router";
import { type FC, useState } from "react";

import { EmptyState } from "~/ui/feedback/empty-state";
import { Row } from "~/ui/layout";
import { Button, buttonVariants } from "~/ui/primitives/button";

import { PhotoGrid } from "../entity-media/photo-grid";
import { PhotoViewer } from "../entity-media/photo-viewer";

interface EntityImageListProps {
  images: Pick<ImageOut, "id" | "fields" | "filename">[];
  showViewAllButton?: boolean;
  /**
   * Detaching belongs to the owning entity. The removal button is a sibling of
   * the preview target so removal never opens the image viewer.
   */
  onRemove?: (imageId: string) => void;
  /** Preserve the whole scene for context-heavy photos such as garden beds. */
  imageFit?: "cover" | "contain";
}

const EntityImageList: FC<EntityImageListProps> = ({
  images,
  showViewAllButton = true,
  onRemove,
  imageFit = "cover",
}) => {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  return (
    <div>
      {images.length === 0 ? (
        <EmptyState size="inline">
          No images yet. Upload images to see them here.
        </EmptyState>
      ) : (
        <div>
          <PhotoGrid
            imageUrl={publicImageUrl}
            images={images}
            fit={imageFit}
            className="mb-4"
            onSelect={(_image, index) => setViewerIndex(index)}
            renderOverlay={
              onRemove
                ? (image) => (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={`Remove ${image.filename}`}
                      title={`Remove ${image.filename}`}
                      className="absolute top-1 right-1 z-20 size-6 bg-[var(--background)] text-muted-foreground hover:text-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(image.id);
                      }}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  )
                : undefined
            }
          />
          <PhotoViewer
            imageUrl={publicImageUrl}
            images={images}
            index={viewerIndex}
            onIndexChange={setViewerIndex}
            onOpenChange={(open) => {
              if (!open) setViewerIndex(null);
            }}
            detailLink={(image) => ({ shortcode: image.id })}
          />

          {showViewAllButton && (
            <Row justify="end">
              <Link
                to="/images"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                View All Images
              </Link>
            </Row>
          )}
        </div>
      )}
    </div>
  );
};

export default EntityImageList;
