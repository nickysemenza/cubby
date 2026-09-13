import type { ImageShortcode } from "@cubby/schemas/identifiers";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@cubby/schemas/image";
import { useRef } from "react";
import { z } from "zod";

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
): Promise<ImageShortcode[]> {
  const ids: ImageShortcode[] = [];
  for (const photo of photos) {
    if (!photo.uploadedId) {
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
      {photos.map((photo, index) => (
        <Row
          key={photo.key ?? photo.file.name}
          gap="sm"
          align="center"
          justify="between"
        >
          <span className="min-w-0 truncate text-sm">
            {photo.file.name}
            {photo.uploadedId ? " · uploaded" : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            aria-label={`Remove ${photo.file.name}`}
            onClick={() => onChange(photos.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </Row>
      ))}
    </Stack>
  );
}
