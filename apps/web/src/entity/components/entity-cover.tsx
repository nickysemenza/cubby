import type { Entity } from "@cubby/schemas/entity";
import {
  preferredImageUrl,
  type ImageUrlSummary,
} from "@cubby/schemas/image-summary";
import { ImageBrokenIcon } from "@phosphor-icons/react/dist/csr/ImageBroken";
import { cn } from "cn";
import type { ReactNode } from "react";

import { EntityIcon } from "~/entity/entities";
import { Image } from "~/ui/media/image";
import { TileOverlay } from "~/ui/media/tile-overlay";

interface EntityCoverProps {
  imageCount?: number;
  images: readonly ImageUrlSummary[];
  entity?: Entity;
  alt?: string;
  size?: number;
  className?: string;
  fit?: "cover" | "contain";
  preview?: boolean;
  placeholder?: "entity" | "none";
  fallback?: ReactNode;
  to?: string;
  params?: Record<string, string>;
}

/**
 * One selective-cover treatment for dense tables, compact cards, search, and
 * the calendar. It always reserves a square, uses transformed image widths,
 * and degrades to an intentional entity mark instead of a broken image glyph.
 */
export function EntityCover({
  images,
  imageCount,
  entity,
  alt = "",
  size,
  className,
  fit = "contain",
  preview = (size ?? 64) < 256,
  placeholder = "entity",
  fallback,
  to,
  params,
}: EntityCoverProps) {
  const placeholderContent =
    fallback ??
    (entity ? (
      <EntityIcon entity={entity} className="size-4" />
    ) : (
      <ImageBrokenIcon
        className="size-4 text-muted-foreground/40"
        aria-hidden
      />
    ));

  if (images.length === 0 && placeholder === "none") return null;

  const image = images[0];
  const style = size == null ? undefined : { width: size, height: size };
  const shellClassName = cn(
    "relative aspect-square shrink-0 overflow-hidden bg-muted/30",
    className,
  );

  if (!image) {
    return (
      <div
        className={cn(shellClassName, "flex items-center justify-center")}
        style={style}
      >
        {placeholderContent}
      </div>
    );
  }

  const mediaFallback = (
    <div className="flex h-full w-full items-center justify-center bg-muted/30">
      {placeholderContent}
    </div>
  );

  return (
    <div className={shellClassName} style={style}>
      <Image
        src={preferredImageUrl(image)}
        alt={alt}
        to={to}
        params={params}
        preview={preview}
        fallback={mediaFallback}
        loadingFallback={mediaFallback}
        displayWidth={size ?? 64}
        fit={fit}
        className="absolute inset-0 h-full w-full bg-card"
      />
      <TileOverlay count={(imageCount ?? images.length) - 1} />
    </div>
  );
}

export type { EntityCoverProps };
