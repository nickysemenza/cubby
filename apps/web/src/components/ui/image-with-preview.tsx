import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Image } from "~/components/ui/image";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export interface ImageWithPreviewProps {
  /** Image source URL */
  src: string;
  /** Alt text for accessibility */
  alt: string;
  /** TanStack Router route path - if provided, thumbnail becomes clickable */
  to?: string;
  /** Route params for dynamic routes (e.g., { id: "123" }) */
  params?: Record<string, string>;
  /** Thumbnail size in pixels (default: 40) */
  size?: number;
  /** Preview popup size in pixels (default: 200) */
  previewSize?: number;
  /** Which side to show the preview (default: "right") */
  previewSide?: "top" | "right" | "bottom" | "left";
  /** Delay mounting the preview until the first open */
  lazyPreview?: boolean;
  /** Additional classes for the thumbnail container (can override defaults like rounded, border) */
  className?: string;
  /** Graceful fallback rendered when the image is missing or fails to load. */
  fallback?: ReactNode;
  /**
   * Overrides the thumbnail's CF-transform width, which otherwise follows
   * `size` (the popup always transforms at `previewSize`). Only needed when the
   * box is sized by `className` rather than `size` — leaving both unset serves
   * the full-size original, which is never what a thumbnail wants.
   */
  displayWidth?: number;
  /**
   * How the thumbnail fills its box. `"cover"` (default) crops to fill — right
   * for square/uniform items; `"contain"` letterboxes the whole image on the
   * container surface — right for portrait product photos (jars, bottles) so
   * nothing is cut off. The hover-preview popup always uses `contain`.
   */
  fit?: "cover" | "contain";
  /**
   * Classes for the preview popup's positioner — the element carrying the
   * stacking context. Needed only when the thumbnail lives inside another
   * portalled popup that would otherwise paint over the preview (e.g. the
   * combobox popup at `z-[200]`).
   */
  previewPositionerClassName?: string;
}

/**
 * Thumbnail image that shows a larger preview on hover.
 * Use this anywhere you display small thumbnails that users might want to see larger.
 */
export function ImageWithPreview({
  src,
  alt,
  to,
  params,
  size,
  previewSize = 200,
  previewSide = "right",
  lazyPreview = false,
  className,
  fallback,
  // Defaulting to `size` is what keeps the transform width and the layout box
  // from silently diverging — an omitted `displayWidth` used to mean "serve the
  // multi-MB original into a 32px tile".
  displayWidth = size,
  fit = "cover",
  previewPositionerClassName,
}: ImageWithPreviewProps) {
  const thumbnailClasses = cn(
    "bg-background relative flex-shrink-0 overflow-hidden rounded-none border transition-transform hover:scale-105",
    className,
  );

  // Only apply inline size when provided (undefined = rely on className for sizing)
  const sizeStyle = size != null ? { width: size, height: size } : undefined;
  const thumbnail = to ? (
    <Link
      to={to}
      params={params}
      className={thumbnailClasses}
      style={sizeStyle}
    />
  ) : (
    <div className={thumbnailClasses} style={sizeStyle} />
  );

  return (
    <Tooltip lazy={lazyPreview}>
      <TooltipTrigger render={thumbnail}>
        <Image
          src={src}
          alt={alt}
          fallback={fallback}
          displayWidth={displayWidth}
          className={cn(
            "absolute inset-0 h-full w-full",
            fit === "contain" ? "bg-card object-contain" : "object-cover",
          )}
        />
      </TooltipTrigger>
      <TooltipContent
        side={previewSide}
        positionerClassName={previewPositionerClassName}
        // max-w-none: the tooltip popup's default max-w-xs (320px) silently
        // clips any previewSize above 320 — the "weird crop".
        // pointer-events-none: the popup is purely a look at the image, and it
        // is portalled over whatever surface the thumbnail sits in — on the
        // arrange board that surface is a drag-and-drop hit-test area, and on a
        // combobox it is the option list.
        className="bg-popover pointer-events-none max-w-none border-[var(--border)] overflow-hidden rounded-none border p-0"
      >
        <div
          className="relative"
          style={{ width: previewSize, height: previewSize }}
        >
          <Image
            src={src}
            alt={alt}
            displayWidth={previewSize}
            className="absolute inset-0 h-full w-full bg-card object-contain"
          />
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
