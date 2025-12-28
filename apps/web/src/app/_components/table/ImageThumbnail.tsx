import { ImageIcon } from "lucide-react";
import { ImageWithPreview } from "~/components/ui/image-with-preview";

interface ImageData {
  id: string;
  url: string;
  filename?: string;
}

const sizeMap = {
  xs: 20,
  sm: 32,
  md: 48,
} as const;

interface ImageThumbnailProps {
  images: ImageData[];
  alt?: string;
  size?: keyof typeof sizeMap;
}

export const ImageThumbnail = ({
  images,
  alt = "Image",
  size = "sm",
}: ImageThumbnailProps) => {
  const pixelSize = sizeMap[size];

  if (images.length === 0) {
    return (
      <div
        className="flex items-center justify-center overflow-hidden rounded-md border bg-muted/30"
        style={{ width: pixelSize, height: pixelSize }}
      >
        <ImageIcon className="h-4 w-4 text-muted-foreground/30" />
      </div>
    );
  }

  const image = images[0];

  return (
    <div className="relative">
      <ImageWithPreview
        src={image.url}
        alt={alt}
        size={pixelSize}
        previewSize={200}
        previewSide="right"
      />
      {images.length > 1 && (
        <div className="absolute right-0 bottom-0 flex h-4 w-4 items-center justify-center rounded-tl-md bg-black/70 text-[10px] text-white">
          +{images.length - 1}
        </div>
      )}
    </div>
  );
};
