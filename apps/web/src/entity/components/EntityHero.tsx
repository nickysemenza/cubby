import { Link } from "@tanstack/react-router";
import { type FC, useState } from "react";

import { cn } from "~/lib/utils";
import { Image } from "~/ui/primitives/image";

interface HeroImage {
  id: string;
  url: string;
  filename: string;
}

interface EntityHeroProps {
  images: HeroImage[];
  /** Relationship label for sourced single-image media such as Vendor.logo. */
  title?: string;
}

/** Shared detail-rail media; image management stays in the declared section. */
export const EntityHero: FC<EntityHeroProps> = ({
  images,
  title = "Images",
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  if (images.length === 0) return null;
  const activeImage = images[activeIndex] ?? images[0]!;
  const displayedIndex = images.indexOf(activeImage);

  return (
    <figure className="m-0 space-y-2">
      <Link
        to="/images/$shortcode"
        params={{ shortcode: activeImage.id }}
        className="relative block aspect-[4/3] overflow-hidden rounded-md bg-card"
      >
        <Image
          src={activeImage.url}
          alt={activeImage.filename}
          displayWidth={320}
          className="absolute inset-0 h-full w-full object-contain"
        />
      </Link>
      <figcaption className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{title}</span>
        {images.length > 1 && (
          <span className="tabular-nums">
            {displayedIndex + 1} / {images.length}
          </span>
        )}
      </figcaption>
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-1">
          {images.map((image, index) => (
            <button
              key={image.id}
              type="button"
              aria-label={`Show image ${index + 1}: ${image.filename}`}
              aria-pressed={index === displayedIndex}
              onClick={() => setActiveIndex(index)}
              className={cn(
                "relative size-12 shrink-0 overflow-hidden rounded-sm transition-opacity duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                index === displayedIndex
                  ? "ring-1 ring-primary"
                  : "opacity-60 hover:opacity-100",
              )}
            >
              <Image
                src={image.url}
                alt={image.filename}
                displayWidth={48}
                className="absolute inset-0 h-full w-full bg-card object-contain"
              />
            </button>
          ))}
        </div>
      )}
    </figure>
  );
};
