"use client";

import { FC } from "react";
import Image from "next/image";
import Link from "next/link";
import { NoneState } from "./NoneState";
import { Button } from "~/components/ui/button";
import { type ImageOut } from "~/schemas/image";

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
          <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {images.map((image) => (
              <Link
                href={`/images/${image.id}`}
                key={image.id}
                className="group block"
              >
                <div className="hover:border-primary relative aspect-square overflow-hidden rounded-md border transition-colors">
                  <Image
                    src={image.url}
                    alt={image.filename}
                    fill
                    sizes="(max-width: 768px) 50vw, (max-width: 1200px) 33vw, 25vw"
                    className="object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                </div>
                <p className="mt-1 truncate text-sm">{image.filename}</p>
              </Link>
            ))}
          </div>

          {showViewAllButton && (
            <div className="flex justify-end">
              <Link href="/images">
                <Button variant="outline" size="sm">
                  View All Images
                </Button>
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default EntityImageList;
