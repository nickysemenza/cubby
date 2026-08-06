import { type ImageOut, isDisplayableImageFile } from "@cubby/schemas/image";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Image } from "~/components/ui/image";
import { cn } from "~/lib/utils";

interface ArrangeThumbProps {
  /** Candidate covers; the first displayable one wins. */
  images: readonly ImageOut[];
  alt: string;
  /** Rendered edge in CSS pixels — also the Cloudflare transform width. */
  size: number;
  /** Glyph shown when there's no usable cover (the card's own icon). */
  fallback: ReactNode;
  /** Detail route this tile opens. */
  to: "/products/$shortcode" | "/locations/$shortcode";
  shortcode: string;
  className?: string;
}

/**
 * The cover tile on every arrange card — items, board location cards, and tree
 * rows — so all three share one size, one empty state, and one way to reach the
 * entity's detail page. Nothing else on this surface navigates (a card click
 * drills, the chevron zooms), so the tile is the arrange surface's "open this".
 *
 * Filtering here is load-bearing for **locations**: `makeTree` hydrates location
 * images behind only a `notDeleted` guard (not `displayableImageWhere`), so
 * `images[0]` can be a PDF manual. Product images arrive already filtered by
 * `ProductImageSummariesProvider`; filtering twice is free and keeps the two
 * callers symmetric.
 *
 * A bare `<Image>` rather than one of the wrappers is deliberate:
 * `CardThumbnail` returns null when empty (which would break name alignment
 * down a column), and `ImageThumbnail` is a 64px table cell carrying a hover
 * preview and a `+N` badge. A hover preview is actively unwanted here — an
 * interactive trigger can swallow native drag-start on the card it sits in.
 */
export function ArrangeThumb({
  images,
  alt,
  size,
  fallback,
  to,
  shortcode,
  className,
}: ArrangeThumbProps) {
  const cover = images.find(isDisplayableImageFile);
  const box = cn("size-full overflow-hidden rounded-sm object-contain");
  const style = { width: size, height: size };

  return (
    // `draggable={false}` is load-bearing: an <a> is a native drag source, so
    // without it a drag started here would carry the link's URL instead of the
    // card's pragmatic-drag-and-drop payload. Disabling it hands the drag up to
    // the nearest draggable ancestor — the card itself — which is what we want.
    <Link
      to={to}
      params={{ shortcode }}
      draggable={false}
      title={`Open ${alt}`}
      aria-label={`Open ${alt}`}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "shrink-0 rounded-sm hover:ring-1 hover:ring-primary",
        className,
      )}
      style={style}
    >
      {cover ? (
        <Image
          src={cover.url}
          alt={alt}
          displayWidth={size}
          className={box}
          fallback={fallback}
        />
      ) : (
        <span
          className={cn(
            box,
            "flex items-center justify-center bg-muted/30 text-muted-foreground",
          )}
        >
          {fallback}
        </span>
      )}
    </Link>
  );
}
