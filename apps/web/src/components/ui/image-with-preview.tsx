
import { Link } from "@tanstack/react-router";
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
  /** Additional classes for the thumbnail container (can override defaults like rounded, border) */
  className?: string;
}

/**
 * Thumbnail image that shows a larger preview on hover.
 * Use this anywhere you display small thumbnails that users might want to see larger.
 *
 * @example
 * // Basic usage
 * <ImageWithPreview src="/photo.jpg" alt="Product photo" />
 *
 * // With link and custom sizes
 * <ImageWithPreview
 *   src="/photo.jpg"
 *   alt="Product photo"
 *   to="/products/$id"
 *   params={{ id: "123" }}
 *   size={32}
 *   previewSize={240}
 * />
 */
export function ImageWithPreview({
  src,
  alt,
  to,
  params,
  size,
  previewSize = 200,
  previewSide = "right",
  className,
}: ImageWithPreviewProps) {
  const thumbnailClasses = cn(
    "bg-background relative flex-shrink-0 overflow-hidden rounded border transition-transform hover:scale-105",
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
    <Tooltip>
      <TooltipTrigger render={thumbnail}>
        <Image
          src={src}
          alt={alt}
          className="absolute inset-y-0 left-1/2 -translate-x-1/2 h-full aspect-square object-cover"
        />
      </TooltipTrigger>
      <TooltipContent
        side={previewSide}
        className="bg-background border-border overflow-hidden rounded-lg border p-0 shadow-lg"
      >
        <div
          className="relative"
          style={{ width: previewSize, height: previewSize }}
        >
          <Image
            src={src}
            alt={alt}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
