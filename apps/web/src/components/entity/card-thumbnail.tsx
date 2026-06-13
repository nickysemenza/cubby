import { ImageWithPreview } from "~/components/ui/image-with-preview";

interface CardThumbnailProps {
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
  if (images.length === 0) return null;

  const image = images[0]!;

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded"
      style={{ width: size, height: size }}
    >
      <ImageWithPreview
        src={image.url}
        alt={alt}
        to={to}
        params={params}
        lazyPreview
        displayWidth={size}
        className="absolute inset-0 h-full w-full rounded-none border-0"
      />
      {images.length > 1 && (
        <div className="absolute right-0 bottom-0 flex h-3 w-3 items-center justify-center bg-black/70 text-3xs text-white">
          +{images.length - 1}
        </div>
      )}
    </div>
  );
}
