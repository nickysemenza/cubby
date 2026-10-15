import type { ImageWithEntity } from "@cubby/schemas/image";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { useState } from "react";

import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Image } from "~/ui/primitives/image";

interface ImageDetailProps {
  image: ImageWithEntity;
}

/** The record's media, shared by the phone hero and desktop detail rail. */
export function ImageDetailMedia({ image }: ImageDetailProps) {
  const [preview, setPreview] = useState<"original" | "transparent" | null>(
    null,
  );
  const transparent = image.representations?.transparent;
  const showTransparent =
    transparent &&
    (preview === "transparent" ||
      (preview === null &&
        image.representations?.preferredKind === "transparent"));
  return (
    <div className="space-y-2">
      {image.status === "UPLOADED" ? (
        <div
          className="flex flex-wrap gap-2"
          aria-label="Image preview representation"
        >
          <Button
            size="sm"
            variant="outline"
            aria-pressed={!showTransparent}
            onClick={() => setPreview("original")}
          >
            Original
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-pressed={!!showTransparent}
            disabled={!transparent}
            onClick={() => setPreview("transparent")}
          >
            Transparent
          </Button>
        </div>
      ) : null}
      <div className="relative aspect-square w-full overflow-hidden border-y border-border bg-card md:max-w-sm md:rounded-md md:border">
        {image.status === "UPLOADED" ? (
          <Image
            src={
              preview === "original"
                ? image.url
                : showTransparent
                  ? (transparent ?? image.url)
                  : preferredImageUrl(image)
            }
            alt={image.filename}
            displayWidth={640}
            className="absolute inset-0 h-full w-full object-contain"
            style={
              showTransparent
                ? {
                    backgroundColor: "var(--color-card)",
                    backgroundImage:
                      "conic-gradient(var(--color-muted) 25%, transparent 0 50%, var(--color-muted) 0 75%, transparent 0)",
                    backgroundSize: "16px 16px",
                  }
                : undefined
            }
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
    </div>
  );
}
