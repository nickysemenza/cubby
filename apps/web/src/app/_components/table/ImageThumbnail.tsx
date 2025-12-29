import { ImageIcon } from "lucide-react";
import { ImageWithPreview } from "~/components/ui/image-with-preview";

interface ImageData {
  id: string;
  url: string;
  filename?: string;
}

interface ImageThumbnailProps {
  images: ImageData[];
  alt?: string;
}

/** Compact image thumbnail that fills cell height (cell must have h-px trick). */
export const ImageThumbnail = ({
  images,
  alt = "Image",
}: ImageThumbnailProps) => {
  if (images.length === 0) {
    return (
      <div className="flex aspect-square h-full items-center justify-center bg-muted/30">
        <ImageIcon className="h-3 w-3 text-muted-foreground/30" />
      </div>
    );
  }

  const image = images[0];

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
};
