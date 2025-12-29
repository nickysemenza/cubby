import { ImageIcon } from "lucide-react";
import { ImageWithPreview } from "~/components/ui/image-with-preview";

interface ImageData {
  id: string;
  url: string;
  filename?: string;
}

const sizeMap = {
  sm: 28,
  md: 48,
} as const;

interface ImageThumbnailProps {
  images: ImageData[];
  alt?: string;
  /** Optional fixed size. When omitted, fills cell height (for table rows). */
  size?: keyof typeof sizeMap;
}

export const ImageThumbnail = ({
  images,
  alt = "Image",
  size,
}: ImageThumbnailProps) => {
  // Compact mode (no size): fills cell via absolute positioning (cell must be relative)
  // Fixed size mode: uses sizeMap with border/rounding
  const compactMode = size === undefined;
  const pixelSize = size ? sizeMap[size] : undefined;

  if (images.length === 0) {
    return (
      <div
        className={
          compactMode
            ? "flex aspect-square h-full items-center justify-center bg-muted/30"
            : "flex items-center justify-center overflow-hidden rounded-md border bg-muted/30"
        }
        style={pixelSize ? { width: pixelSize, height: pixelSize } : undefined}
      >
        <ImageIcon className="h-3 w-3 text-muted-foreground/30" />
      </div>
    );
  }

  const image = images[0];

  if (compactMode) {
    // Cell has h-px trick, so h-full fills the actual row height
    return (
      <div className="relative h-full">
        <ImageWithPreview
          src={image.url}
          alt={alt}
          size={undefined}
          className="aspect-square h-full rounded-none border-0"
        />
        {images.length > 1 && (
          <div className="absolute right-0 bottom-0 flex h-3 w-3 items-center justify-center bg-black/70 text-[8px] text-white">
            +{images.length - 1}
          </div>
        )}
      </div>
    );
  }

  // Fixed size mode
  return (
    <div className="relative" style={{ width: pixelSize, height: pixelSize }}>
      <ImageWithPreview src={image.url} alt={alt} size={pixelSize} />
      {images.length > 1 && (
        <div className="absolute right-0 bottom-0 flex h-4 w-4 items-center justify-center rounded-tl-md bg-black/70 text-[10px] text-white">
          +{images.length - 1}
        </div>
      )}
    </div>
  );
};
