import { Link } from "@tanstack/react-router";
import { ImageIcon, X } from "lucide-react";
import { type FC, Fragment } from "react";
import { Grid, Row } from "~/components/layout";
import { InteractiveImage } from "~/components/media/interactive-image";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

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
   * Opt-in detach affordance: an X on each thumbnail. Omitted, the list stays
   * display-only and renders exactly the markup it always did — the button is a
   * SIBLING of the tile's `<Link>` (never nested inside it: a button inside an
   * anchor is invalid, and the click would navigate to the image page instead of
   * detaching). Detaching is the owning entity's call, so the handler gets the
   * image id and nothing else.
   */
  onRemove?: (imageId: string) => void;
}

const EntityImageList: FC<EntityImageListProps> = ({
  images,
  showViewAllButton = true,
  onRemove,
}) => {
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
          <Grid cols="thumbs" className="mb-4">
            {images.map((image) => {
              const tile = (
                <Link
                  to="/images/$id"
                  params={{ id: image.id }}
                  className="group block"
                >
                  <InteractiveImage
                    src={image.url}
                    alt={image.filename}
                    displayWidth={256}
                    hoverEffect="both"
                    transition="all"
                  />
                  <p className="mt-1 truncate text-sm" title={image.filename}>
                    {image.filename}
                  </p>
                </Link>
              );
              // Fragment, not a wrapper div, in the display-only case: the
              // positioning context only exists when there's a button to
              // position, so every existing caller's DOM is unchanged.
              if (!onRemove) return <Fragment key={image.id}>{tile}</Fragment>;
              return (
                <div key={image.id} className="relative">
                  {tile}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`Remove ${image.filename}`}
                    title={`Remove ${image.filename}`}
                    className="absolute top-1 right-1 size-6 bg-[var(--background)] text-muted-foreground hover:text-destructive"
                    onClick={() => onRemove(image.id)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </Grid>

          {showViewAllButton && (
            <Row justify="end">
              <Link to="/images">
                <Button variant="outline" size="sm">
                  View All Images
                </Button>
              </Link>
            </Row>
          )}
        </div>
      )}
    </div>
  );
};

export default EntityImageList;
