import Image from "next/image";
import { cva, type VariantProps } from "class-variance-authority";

interface ImageData {
  id: string;
  url: string;
  filename?: string;
}

const thumbnailVariants = cva(
  "flex items-center justify-center rounded-md border",
  {
    variants: {
      size: {
        sm: "h-8 w-8",
        md: "h-12 w-12",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  },
);

const containerVariants = cva("relative overflow-hidden rounded-md border", {
  variants: {
    size: {
      sm: "h-8 w-8",
      md: "h-12 w-12",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

interface ImageThumbnailProps extends VariantProps<typeof thumbnailVariants> {
  images?: ImageData[];
  alt?: string;
}

const EmptyImagePlaceholder = ({
  size,
}: VariantProps<typeof thumbnailVariants>) => (
  <div className={thumbnailVariants({ size, className: "bg-gray-100" })}>
    <span className="text-xs text-gray-500">-</span>
  </div>
);

const ImageBadge = ({ count }: { count: number }) => (
  <div className="absolute right-0 bottom-0 flex h-3 w-3 items-center justify-center rounded-tl-md bg-black/70 text-xs text-white">
    +{count}
  </div>
);

export const ImageThumbnail = ({
  images,
  alt = "Image",
  size = "sm",
}: ImageThumbnailProps) => {
  if (!images || images.length === 0) {
    return <EmptyImagePlaceholder size={size} />;
  }

  const image = images[0];
  const sizePx = size === "md" ? "48px" : "32px";

  return (
    <div className={containerVariants({ size })}>
      <Image
        src={image.url}
        alt={alt}
        fill
        sizes={sizePx}
        className="object-cover"
      />
      {images.length > 1 && <ImageBadge count={images.length - 1} />}
    </div>
  );
};
