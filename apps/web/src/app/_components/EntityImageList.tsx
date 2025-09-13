"use client";

import { FC } from "react";
import Link from "next/link";
import { NoneState } from "./NoneState";
import { Button } from "~/components/ui/button";
import { type ImageOut } from "~/schemas/image";
import { GridContainer } from "~/components/ui/grid-container";
import { FlexContainer } from "~/components/ui/flex-container";
import { InteractiveImage } from "~/components/ui/interactive-image";

interface EntityImageListProps {
  images: ImageOut[] | undefined;
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
      {title && <h2 className="mb-3 text-xl font-semibold">{title}</h2>}

      {!images || images.length === 0 ? (
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
