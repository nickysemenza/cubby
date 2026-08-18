import { type ImageOut, isDisplayableImageFile } from "@cubby/schemas/image";
import { Link } from "@tanstack/react-router";
import type React from "react";
import type { ReactNode } from "react";
import { Image } from "~/components/ui/image";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

const PREVIEW_PX = 280;

interface ArrangeThumbProps {
  /** Candidate covers; the first displayable one wins. */
  images: readonly ImageOut[];
  alt: string;
  /** Rendered width in CSS pixels — also the Cloudflare transform width. */
  size: number;
  /** Glyph shown when there's no usable cover (the card's own icon). */
  fallback: ReactNode;
  /** Detail route this tile opens. */
  to: "/products/$shortcode" | "/locations/$shortcode";
  shortcode: string;
  /**
   * Fill the row's height instead of being a `size`-square. `size` stays the
   * width (and the transform width); `size` also floors the height so a
   * single-line row doesn't collapse the tile. The row is responsible for
   * cancelling its own vertical padding (`-my-*`) so the tile is full-bleed.
   */
  fill?: boolean;
  className?: string;
}

/**
 * The cover tile on every arrange card — items, board location cards, and tree
 * rows — so all three share one size, one empty state, one hover preview, and
 * one way to reach the entity's detail page. Nothing else on this surface
 * navigates (a card click drills, the chevron zooms), so the tile is the
 * arrange surface's "open this".
 *
 * Filtering here is load-bearing for **locations**: `makeTree` hydrates location
 * images behind only a `notDeleted` guard (not `displayableImageWhere`), so
 * `images[0]` can be a PDF manual. Product images arrive already filtered by
 * `ProductImageSummariesProvider`; filtering twice is free and keeps the two
 * callers symmetric.
 *
 * Rendering the bare `Image` primitive rather than one of its wrappers is
 * deliberate: `CardThumbnail` returns null when empty (which would break name
 * alignment down a column), and `ImageThumbnail` is a 64px table cell carrying
 * a `+N` badge. `ImageWithPreview` doesn't fit either — it owns its trigger
 * element, and this tile's three drag-safety attributes below are exactly what
 * a generic trigger would drop.
 *
 * The hover preview is drag-safe by construction, which is what a tile inside a
 * native-drag source needs:
 *  - the trigger is the tile's own `<Link>` (Base UI merges onto it), so
 *    `draggable={false}` and the click-stop survive;
 *  - the popup is `pointer-events-none`, so it can't shadow pdnd's innermost
 *    drop-target hit test or the tree row's spring-load enter/leave timers;
 *  - while a drag is in flight the whole tile stops taking pointer events (the
 *    `arrange-dragging` body class set by the dnd provider), so no preview can
 *    open — or linger — under the drop indicator.
 */
export function ArrangeThumb({
  images,
  alt,
  size,
  fallback,
  to,
  shortcode,
  fill = false,
  className,
}: ArrangeThumbProps) {
  const cover = images.find(isDisplayableImageFile);
  const box = cn("size-full overflow-hidden rounded-sm object-contain");

  const linkProps = {
    to,
    params: { shortcode },
    // `draggable={false}` is load-bearing: an <a> is a native drag source, so
    // without it a drag started here would carry the link's URL instead of the
    // dnd-kit draggable node. Drag activation is deliberately limited to the
    // dedicated grip, while the link stays a normal navigation affordance.
    draggable: false,
    title: `Open ${alt}`,
    "aria-label": `Open ${alt}`,
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
    className: cn(
      "shrink-0 rounded-sm hover:ring-1 hover:ring-primary",
      // `self-stretch` alone, never `h-full`: a percentage height resolves
      // against the row's content box (i.e. inside its padding) and then gets
      // clamped by the min-height, so the tile would silently stop growing at
      // its floor instead of following the row.
      fill && "self-stretch",
      // Inert while a drag is in flight (class set by the dnd provider), so the
      // hover preview can't open — or stay open — over a drop target.
      "[.arrange-dragging_&]:pointer-events-none",
      className,
    ),
    style: fill
      ? { width: size, minHeight: size }
      : { width: size, height: size },
  } as const;

  if (!cover) {
    return (
      <Link {...linkProps}>
        <span
          className={cn(
            box,
            "flex items-center justify-center bg-muted/30 text-muted-foreground",
          )}
        >
          {fallback}
        </span>
      </Link>
    );
  }

  return (
    <Tooltip lazy>
      <TooltipTrigger render={<Link {...linkProps} />}>
        <Image
          src={cover.url}
          alt={alt}
          displayWidth={size}
          className={box}
          fallback={fallback}
        />
      </TooltipTrigger>
      <TooltipContent
        side="right"
        className="pointer-events-none max-w-none overflow-hidden rounded-none border border-[var(--border)] bg-popover p-0"
      >
        <div
          className="relative"
          style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
        >
          <Image
            src={cover.url}
            alt={alt}
            displayWidth={PREVIEW_PX}
            className="absolute inset-0 size-full bg-card object-contain"
          />
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
