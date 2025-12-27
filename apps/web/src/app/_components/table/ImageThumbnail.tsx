import { cva, type VariantProps } from "class-variance-authority";
import { NoneState } from "~/app/_components/NoneState";
import { Image } from "~/components/ui/image";

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

  return (
    <div className={containerVariants({ size })}>
      <Image
        src={image.url}
        alt={alt}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {images.length > 1 && <ImageBadge count={images.length - 1} />}
    </div>
  );
};
