import { preferredImageUrl } from "@cubby/schemas/image-summary";
import { ArrowSquareOutIcon as ExternalLink } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretLeftIcon as ChevronLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Link } from "@tanstack/react-router";

import { Button, buttonVariants } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Image } from "~/components/ui/image";

import type { PhotoGridImage } from "./photo-grid";

interface PhotoViewerProps<TImage extends PhotoGridImage> {
  images: TImage[];
  index: number | null;
  onOpenChange: (open: boolean) => void;
  onIndexChange: (index: number) => void;
  detailLink?: (image: TImage) => { shortcode: string };
}

/** Full-scene viewer: arrows move through the same ordered batch as the grid. */
export function PhotoViewer<TImage extends PhotoGridImage>({
  images,
  index,
  onOpenChange,
  onIndexChange,
  detailLink,
}: PhotoViewerProps<TImage>) {
  const currentIndex = index ?? 0;
  const image = images[currentIndex];
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;

  if (!image) return null;

  return (
    <Dialog open={index !== null} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[calc(100dvh-2rem)] p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="truncate">{image.filename}</DialogTitle>
          <DialogDescription>
            Image {currentIndex + 1} of {images.length}
          </DialogDescription>
        </DialogHeader>
        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-3 sm:p-5">
          <Image
            key={image.id}
            src={preferredImageUrl(image)}
            alt={image.filename}
            displayWidth={1600}
            className="max-h-[calc(100dvh-13rem)] w-full object-contain"
          />
          {hasPrevious ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="absolute top-1/2 left-4 -translate-y-1/2"
              aria-label="Previous image"
              onClick={() => onIndexChange(currentIndex - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
          ) : null}
          {hasNext ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="absolute top-1/2 right-4 -translate-y-1/2"
              aria-label="Next image"
              onClick={() => onIndexChange(currentIndex + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          ) : null}
        </div>
        <div className="flex justify-end border-t px-5 py-3">
          {detailLink ? (
            <Link
              to="/images/$shortcode"
              params={detailLink(image)}
              className={buttonVariants({ variant: "secondary" })}
            >
              <ExternalLink className="size-3.5" />
              View image details
            </Link>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
