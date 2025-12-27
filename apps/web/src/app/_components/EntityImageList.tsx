"use client";

import Link from "next/link";
import type { FC } from "react";
import { FlexContainer } from "~/components/layout/flex-container";
import { GridContainer } from "~/components/layout/grid-container";
import { InteractiveImage } from "~/components/media/interactive-image";
import { Button } from "~/components/ui/button";
import { NoneState } from "./NoneState";

/** Minimal image type for display - only the fields we actually use */
interface MinimalImage {
  id: string;
  url: string;
  filename: string;
}

interface EntityImageListProps {
  images: MinimalImage[];
  title?: string;
  showViewAllButton?: boolean;
}

const EntityImageList: FC<EntityImageListProps> = ({
  images,
  title = "Images",
  showViewAllButton = true,
}) => {
  return (
    <div>
      {title && <h2 className="mb-3 font-semibold text-xl">{title}</h2>}

      {images.length === 0 ? (
        <NoneState />
      ) : (
        <div>
          <GridContainer cols="responsive3" className="mb-4">
            {images.map((image) => (
              <Link
                href={`/images/${image.id}`}
                key={image.id}
                className="group block"
              >
                <InteractiveImage
                  src={image.url}
                  alt={image.filename}
                  sizes="(max-width: 768px) 50vw, (max-width: 1200px) 33vw, 25vw"
                  hoverEffect="both"
                  transition="all"
                />
                <p className="mt-1 truncate text-sm">{image.filename}</p>
              </Link>
            ))}
          </GridContainer>

          {showViewAllButton && (
            <FlexContainer justify="end">
              <Link href="/images">
                <Button variant="outline" size="sm">
                  View All Images
                </Button>
              </Link>
            </FlexContainer>
          )}
        </div>
      )}
    </div>
  );
};

export default EntityImageList;
