import {
  preferredImageUrl,
  type ImageRepresentations,
} from "@cubby/schemas/image-summary";
import { type ReactNode } from "react";

import { Image } from "~/components/ui/image";
import { cn } from "~/lib/utils";

export interface PhotoGridImage {
  id: string;
  url: string;
  representations?: ImageRepresentations;
  filename: string;
}

interface PhotoGridProps<TImage extends PhotoGridImage> {
  images: TImage[];
  onSelect?: (image: TImage, index: number) => void;
  renderOverlay?: (image: TImage, index: number) => ReactNode;
  fit?: "cover" | "contain";
  className?: string;
  tileClassName?: string;
}

/** Compact, selectable image grid used for saved records and unsaved drafts. */
export function PhotoGrid<TImage extends PhotoGridImage>({
  images,
  onSelect,
  renderOverlay,
  fit = "cover",
  className,
  tileClassName,
}: PhotoGridProps<TImage>) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4",
        className,
      )}
    >
      {images.map((image, index) => (
        <div
          key={image.id}
          className={cn(
            "group relative aspect-square overflow-hidden rounded-md border border-border bg-muted/30",
            tileClassName,
          )}
        >
          {onSelect ? (
            <button
              type="button"
              className="absolute inset-0 z-10 cursor-zoom-in rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`View ${image.filename}`}
              onClick={() => onSelect(image, index)}
            />
          ) : null}
          <Image
            src={preferredImageUrl(image)}
            alt={image.filename}
            displayWidth={320}
            className={cn(
              "h-full w-full",
              fit === "contain" ? "object-contain" : "object-cover",
            )}
          />
          {renderOverlay?.(image, index)}
        </div>
      ))}
    </div>
  );
}
