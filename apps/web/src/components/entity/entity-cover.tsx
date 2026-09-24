import type { Entity } from "@cubby/schemas/entity";
import {
  preferredImageUrl,
  type ImageRepresentations,
} from "@cubby/schemas/image-summary";
import { ImageBrokenIcon } from "@phosphor-icons/react/dist/csr/ImageBroken";
import type { ReactNode } from "react";

import { Image } from "~/components/ui/image";
import { ImageWithPreview } from "~/components/ui/image-with-preview";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";

/**
 * Deliberately structural, not `DisplayImageSummary` — callers pass both a
 * list row's server-resolved `displayImages` (branded `ImageShortcode` id)
 * and a non-list row's own `images[]`/cascade-resolved cover (plain string
 * id). The branded id would reject the latter, and no single schema covers
 * both — see `ImageThumbnail`'s `ImageData`.
 */
interface CoverImage {
  id: string;
  url: string;
  representations?: ImageRepresentations;
}

interface EntityCoverProps {
  images: readonly CoverImage[];
  entity?: Entity;
  alt?: string;
  size?: number;
  className?: string;
  fit?: "cover" | "contain";
  preview?: boolean;
  lazyPreview?: boolean;
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
  entity,
  alt = "",
  size,
  className,
  fit = entity === "product" ? "contain" : "cover",
  preview = false,
  lazyPreview = false,
  placeholder = "entity",
  fallback,
  to,
  params,
}: EntityCoverProps) {
  const placeholderContent =
    fallback ??
    (entity ? (
      <EntityIcon entity={entity} colored className="size-4" />
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
      {preview ? (
        <ImageWithPreview
          src={preferredImageUrl(image)}
          alt={alt}
          to={to}
          params={params}
          lazyPreview={lazyPreview}
          fallback={mediaFallback}
          displayWidth={size ?? 64}
          fit={fit}
          className="absolute inset-0 h-full w-full rounded-none border-0"
        />
      ) : (
        <Image
          src={preferredImageUrl(image)}
          alt={alt}
          fallback={mediaFallback}
          loadingFallback={mediaFallback}
          displayWidth={size ?? 64}
          className={cn(
            "absolute inset-0 h-full w-full",
            fit === "contain" ? "bg-card object-contain" : "object-cover",
          )}
        />
      )}
      {images.length > 1 && (
        <span className="absolute right-0 bottom-0 flex size-3 items-center justify-center bg-foreground text-3xs text-background">
          +{images.length - 1}
        </span>
      )}
    </div>
  );
}

export type { EntityCoverProps };
