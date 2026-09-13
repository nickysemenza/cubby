import type { ImageShortcode } from "@cubby/schemas/identifiers";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@cubby/schemas/image";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { PhotoGrid } from "~/app/_components/photos/photo-grid";
import { PhotoViewer } from "~/app/_components/photos/photo-viewer";
import { usePhotoDraftPreviews } from "~/app/_components/photos/use-photo-draft-previews";
import { FileDropField } from "~/components/file-upload/FileDropField";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { imageUpload } from "~/lib/image.functions";

const contentTypeSchema = z.enum(ALLOWED_IMAGE_TYPES);
const acceptedTypes = ALLOWED_IMAGE_TYPES.join(",");

export interface GardenPhotoDraft {
  file: File;
  key?: string;
  uploadedId?: ImageShortcode;
  status?: "uploading" | "uploaded" | "failed";
}

export interface GardenPhotoTransport {
  initiate: typeof imageUpload.uploadImage;
  put: typeof fetch;
}
const productionTransport: GardenPhotoTransport = {
  initiate: imageUpload.uploadImage,
  put: (...args) => fetch(...args),
};

/** Keep completed PUTs in the draft so a failed batch save can retry without uploading them again. */
export async function uploadGardenPhotos(
  photos: GardenPhotoDraft[],
  transport: GardenPhotoTransport = productionTransport,
  onProgress?: () => void,
): Promise<ImageShortcode[]> {
  const ids: ImageShortcode[] = [];
  for (const photo of photos) {
    if (!photo.uploadedId) {
      photo.status = "uploading";
      onProgress?.();
      try {
        const contentType = contentTypeSchema.parse(photo.file.type);
        if (photo.file.size > MAX_IMAGE_UPLOAD_BYTES)
          throw new Error(`${photo.file.name} exceeds the upload size limit.`);
        const upload = await transport.initiate.call({
          filename: photo.file.name,
          contentType,
          size: photo.file.size,
          entityType: "GARDENENTRY",
        });
        const response = await transport.put(upload.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: photo.file,
        });
        if (!response.ok)
          throw new Error(
            `Could not upload ${photo.file.name}. Your photos are still selected; please retry.`,
          );
        photo.uploadedId = upload.imageId;
        photo.status = "uploaded";
      } catch (error) {
        photo.status = "failed";
        throw error;
      } finally {
        onProgress?.();
      }
    }
    ids.push(photo.uploadedId);
  }
  return ids;
}

export function GardenPhotos({
  photos,
  onChange,
  disabled,
}: {
  photos: GardenPhotoDraft[];
  onChange: (photos: GardenPhotoDraft[]) => void;
  disabled: boolean;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const drafts = useMemo(
    () =>
      photos.map((photo, index) => ({
        key: photo.key ?? `${photo.file.name}-${index}`,
        file: photo.file,
      })),
    [photos],
  );
  const previews = usePhotoDraftPreviews(drafts);
  const add = (files: File[]) =>
    onChange([
      ...photos,
      ...files.map((file) => ({ file, key: crypto.randomUUID() })),
    ]);
  return (
    <Stack gap="md">
      <FileDropField
        accept={acceptedTypes}
        label="Add photos"
        description="Keep the whole bed or add a close-up. Photos save with this entry."
        multiple
        maxSize={MAX_IMAGE_UPLOAD_BYTES}
        onFilesAdded={add}
        disabled={disabled}
        mode="compact"
      />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-label="Take a garden photo"
        disabled={disabled}
        onChange={(event) => {
          add(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => camera.current?.click()}
        disabled={disabled}
      >
        Take photo
      </Button>
      <PhotoGrid
        images={previews}
        fit="contain"
        onSelect={(_, index) => setPreview(index)}
        renderOverlay={(image, index) => (
          <Row
            justify="between"
            align="center"
            className="absolute inset-x-0 bottom-0 z-20 bg-background/95 p-1"
          >
            <output className="text-xs">
              {photos[index]?.status === "uploading"
                ? "Uploading…"
                : photos[index]?.status === "failed"
                  ? "Upload failed"
                  : photos[index]?.uploadedId
                    ? "Uploaded"
                    : "Selected"}
            </output>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              aria-label={`Remove ${image.filename}`}
              onClick={() => {
                setPreview(null);
                onChange(photos.filter((_, i) => i !== index));
              }}
            >
              Remove
            </Button>
          </Row>
        )}
      />
      <PhotoViewer
        images={previews}
        index={preview}
        onIndexChange={setPreview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      />
    </Stack>
  );
}
