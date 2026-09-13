import { EntityCover } from "~/components/entity/entity-cover";

interface CardThumbnailProps {
  // Structural, not `DisplayImageSummary` — see `EntityCover`'s `CoverImage`.
  images: Array<{ id: string; url: string }>;
  alt?: string;
  /** TanStack Router path for clicking the thumbnail */
  to?: string;
  params?: Record<string, string>;
  /** Thumbnail size in px (default: 40) */
  size?: number;
}

/** Compact image thumbnail for use in card layouts. Returns null when images is empty. */
export function CardThumbnail({
  images,
  alt = "Image",
  to,
  params,
  size = 40,
}: CardThumbnailProps) {
  return (
    <EntityCover
      images={images}
      alt={alt}
      size={size}
      to={to}
      params={params}
      preview
      lazyPreview
      placeholder="none"
    />
  );
}
