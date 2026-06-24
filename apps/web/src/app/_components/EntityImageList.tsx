import { Link } from "@tanstack/react-router";
import { ImageIcon } from "lucide-react";
import type { FC } from "react";
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
}

const EntityImageList: FC<EntityImageListProps> = ({
  images,
  showViewAllButton = true,
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
            {images.map((image) => (
              <Link
                to="/images/$id"
                params={{ id: image.id }}
                key={image.id}
                className="group block"
              >
                <InteractiveImage
                  src={image.url}
                  alt={image.filename}
                  hoverEffect="both"
                  transition="all"
                />
                <p className="mt-1 truncate text-sm">{image.filename}</p>
              </Link>
            ))}
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
