import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { Link } from "@tanstack/react-router";
import { type FC, useState } from "react";

import { Row } from "~/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Image } from "~/components/ui/image";
import { cn } from "~/lib/utils";

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

/**
 * Desktop image card for entity detail pages.
 * Renders as a Card in the grid with a prominent primary image
 * and optional thumbnail strip for multiple images.
 */
export const EntityHero: FC<EntityHeroProps> = ({
  images,
  title = "Images",
}) => {
  const [activeIndex, setActiveIndex] = useState(0);

  if (images.length === 0) return null;

  // images[0] is safe given the length check above; falls back to it if
  // activeIndex ever points past the end (e.g. after the array shrinks).
  const activeImage = images[activeIndex] ?? images[0]!;

  return (
    <Card
      className={cn("animate-in fade-in slide-in-from-bottom-2")}
      style={{ animationFillMode: "both" }}
    >
      <CardHeader className="pb-4">
        <Row align="center" gap="sm">
          <ImageIcon className="size-3.5 text-slate" />
          <CardTitle>{title}</CardTitle>
        </Row>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Primary image, set as a textbook figure: hairline mat + caption */}
        <Link
          to="/images/$shortcode"
          params={{ shortcode: activeImage.id }}
          className="group block"
        >
          <figure className="my-0 rounded-sm border border-border p-2">
            <div className="relative aspect-[4/3] overflow-hidden bg-card">
              <Image
                src={activeImage.url}
                alt={activeImage.filename}
                displayWidth={800}
                className="absolute inset-0 h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.02]"
              />
            </div>
            <figcaption className="pt-2 eyebrow">
              Fig. {String(activeIndex + 1).padStart(2, "0")} / {images.length}
            </figcaption>
          </figure>
        </Link>

        {/* Thumbnail strip for multiple images */}
        {images.length > 1 && (
          <Row align="center" gap="sm">
            <div className="flex gap-2 overflow-x-auto">
              {images.map((image, index) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  className={cn(
                    "relative size-12 flex-shrink-0 overflow-hidden rounded-md transition-all",
                    index === activeIndex
                      ? "ring-2 ring-primary ring-offset-2"
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
            <Link
              to="/images"
              className="ml-auto flex-shrink-0 text-sm text-muted-foreground hover:text-foreground"
            >
              View All
            </Link>
          </Row>
        )}
      </CardContent>
    </Card>
  );
};
