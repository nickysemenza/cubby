import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { Link } from "@tanstack/react-router";
import { type FC, useState } from "react";

import { Row } from "~/components/layout";
import { Button, buttonVariants } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

import { PhotoGrid } from "./photos/photo-grid";
import { PhotoViewer } from "./photos/photo-viewer";

/** Minimal image type for display - only the fields we actually use */
interface MinimalImage {
  id: string;
  url: string;
  filename: string;
}

interface EntityImageListProps {
  images: MinimalImage[];
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
        <Empty variant="minimal" className="py-4">
          <EmptyMedia variant="icon">
            <ImageIcon className="size-4" />
          </EmptyMedia>
          <EmptyTitle>No images</EmptyTitle>
          <EmptyDescription>Upload images to see them here</EmptyDescription>
        </Empty>
      ) : (
        <div>
          <PhotoGrid
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
