"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

interface ImageWithPreviewProps {
  /** Image source URL */
  src: string;
  /** Alt text for accessibility */
  alt: string;
  /** Optional link destination - if provided, thumbnail becomes clickable */
  href?: string;
  /** Thumbnail size in pixels (default: 40) */
  size?: number;
  /** Preview popup size in pixels (default: 200) */
  previewSize?: number;
  /** Which side to show the preview (default: "right") */
  previewSide?: "top" | "right" | "bottom" | "left";
  /** Additional classes for the thumbnail container */
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
 *   href="/products/123"
 *   size={32}
 *   previewSize={240}
 * />
 */
export function ImageWithPreview({
  src,
  alt,
  href,
  size = 40,
  previewSize = 200,
  previewSide = "right",
  className,
}: ImageWithPreviewProps) {
  const thumbnailClasses = cn(
    "bg-background relative flex-shrink-0 overflow-hidden rounded border transition-transform hover:scale-105",
    className,
  );

  const thumbnail = href ? (
    <Link
      href={href}
      className={thumbnailClasses}
      style={{ width: size, height: size }}
    />
  ) : (
    <div className={thumbnailClasses} style={{ width: size, height: size }} />
  );

  return (
    <Tooltip>
      <TooltipTrigger render={thumbnail}>
        <Image
          src={src}
          alt={alt}
          fill
          sizes={`${size}px`}
          className="object-cover"
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
            fill
            sizes={`${previewSize}px`}
            className="object-cover"
          />
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
