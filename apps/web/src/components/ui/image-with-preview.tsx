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
  /** Thumbnail display width in px for CF image transforms (the popup uses previewSize). */
  displayWidth?: number;
  /**
   * How the thumbnail fills its box. `"cover"` (default) crops to fill — right
   * for square/uniform items; `"contain"` letterboxes the whole image on the
   * container surface — right for portrait product photos (jars, bottles) so
   * nothing is cut off. The hover-preview popup always uses `contain`.
   */
  fit?: "cover" | "contain";
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
  displayWidth,
  fit = "cover",
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
        className="bg-popover border-[var(--border)] overflow-hidden rounded-none border p-0"
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
