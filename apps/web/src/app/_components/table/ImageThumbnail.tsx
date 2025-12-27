import { cva, type VariantProps } from "class-variance-authority";
import Image from "next/image";
import { NoneState } from "~/app/_components/NoneState";

interface ImageData {
  id: string;
  url: string;
  filename?: string;
}

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

interface ImageThumbnailProps extends VariantProps<typeof containerVariants> {
  images: ImageData[];
  alt?: string;
}

const ImageBadge = ({ count }: { count: number }) => (
  <div className="absolute right-0 bottom-0 flex h-3 w-3 items-center justify-center rounded-tl-md bg-black/70 text-white text-xs">
    +{count}
  </div>
);

export const ImageThumbnail = ({
  images,
  alt = "Image",
  size = "sm",
}: ImageThumbnailProps) => {
  if (images.length === 0) {
    return <NoneState />;
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
