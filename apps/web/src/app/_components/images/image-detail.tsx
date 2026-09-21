import type { ImageWithEntity } from "@cubby/schemas/image";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import { ImageIcon } from "lucide-react";

import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";

interface ImageDetailProps {
  image: ImageWithEntity;
}

/** The record's media, shared by the phone hero and desktop detail rail. */
export function ImageDetailMedia({ image }: ImageDetailProps) {
  return (
    <div className="relative aspect-square w-full overflow-hidden border-y border-border bg-card md:max-w-sm md:rounded-md md:border">
      {image.status === "UPLOADED" ? (
        <Image
          src={preferredImageUrl(image)}
          alt={image.filename}
          displayWidth={640}
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted/30">
          <div className="text-center">
            <ImageIcon className="mx-auto size-12 text-muted-foreground/50" />
            <Description className="mt-2">
              {image.status === "PENDING"
                ? "Upload pending..."
                : "Upload failed"}
            </Description>
          </div>
        </div>
      )}
    </div>
  );
}
