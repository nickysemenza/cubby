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
  lazyPreview?: boolean;
}

/** Image thumbnail that fills the cell height (cell must have h-px trick). */
export const ImageThumbnail = ({
  images,
  alt = "Image",
  lazyPreview = false,
}: ImageThumbnailProps) => {
  if (images.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex aspect-square h-full items-center justify-center bg-muted/30">
          <ImageIcon className="h-4 w-4 text-muted-foreground/30" />
        </div>
      </div>
    );
  }

  const image = images[0];

  return (
    <div className="flex h-full items-center justify-center">
      <div className="thumbnail-ring relative aspect-square h-full overflow-hidden rounded-lg transition-all duration-200 hover:scale-105 hover:shadow-[var(--shadow-warm-lg)]">
        <ImageWithPreview
          src={image.url}
          alt={alt}
          lazyPreview={lazyPreview}
          className="absolute inset-0 h-full w-full rounded-none border-0"
        />
        {images.length > 1 && (
          <div className="absolute right-0 bottom-0 flex h-3 w-3 items-center justify-center bg-black/70 text-[8px] text-white">
            +{images.length - 1}
          </div>
        )}
      </div>
    </div>
  );
};
