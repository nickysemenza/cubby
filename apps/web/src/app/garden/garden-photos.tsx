import type { GardenEntryOut } from "@cubby/schemas/garden";
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
import { formatDateWithYear } from "~/app/projects/project-formatting";
import { FileDropField } from "~/components/file-upload/FileDropField";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
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
  description,
}: {
  photos: GardenPhotoDraft[];
  onChange: (photos: GardenPhotoDraft[]) => void;
  disabled: boolean;
  /** Help copy under the drop field — say what the photos attach to. */
  description: string;
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
      <Row gap="sm" align="center" wrap>
        <FileDropField
          accept={acceptedTypes}
          label="Add photos"
          description={description}
          multiple
          maxSize={MAX_IMAGE_UPLOAD_BYTES}
          onFilesAdded={add}
          disabled={disabled}
          mode="compact"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => camera.current?.click()}
          disabled={disabled}
        >
          Take photo
        </Button>
      </Row>
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

/**
 * "Note" / "Harvest" / "Move" — the entry-kind vocabulary shared by the
 * journal's date · kind line (`garden-timeline.tsx`) and this strip's photo
 * accessible names. The stored `kind` enum keeps "observation"; that word
 * never reaches UI copy. Exported here (rather than from `garden-timeline.tsx`)
 * so this module stays the one-way import — the timeline already reaches into
 * this file for {@link JournalPhotoStrip}.
 */
export function gardenEntryKindLabel(kind: GardenEntryOut["kind"]): string {
  if (kind === "harvest") return "Harvest";
  if (kind === "move") return "Move";
  return "Note";
}

const JOURNAL_PHOTO_STRIP_CAP = 12;

/**
 * Compact photo strip for the top of a journal card: every image from the
 * currently loaded page of entries, newest first (the order the entries
 * themselves already load in), capped with a "+N" tile so a heavily
 * photographed page doesn't push the entry list below the fold. Each tile's
 * accessible name is "<Kind> photo, <date>" rather than the raw filename —
 * `PhotoGrid`/`PhotoViewer` read that name off `filename`, so the image is
 * projected with a synthetic one before reaching either.
 */
export function JournalPhotoStrip({ entries }: { entries: GardenEntryOut[] }) {
  const [preview, setPreview] = useState<number | null>(null);
  const photos = entries.flatMap((entry) =>
    entry.images.map((image) => ({
      ...image,
      filename: `${gardenEntryKindLabel(entry.kind)} photo, ${formatDateWithYear(entry.observedOn)}`,
    })),
  );
  if (photos.length === 0) return null;
  const shown = photos.slice(0, JOURNAL_PHOTO_STRIP_CAP);
  const hiddenCount = photos.length - shown.length;
  return (
    <>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
        {shown.map((image, index) => (
          <button
            key={image.id}
            type="button"
            className="relative aspect-square overflow-hidden rounded-md border border-border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={`View ${image.filename}`}
            onClick={() => setPreview(index)}
          >
            <Image
              src={image.url}
              alt={image.filename}
              displayWidth={160}
              className="h-full w-full object-cover"
            />
          </button>
        ))}
        {hiddenCount > 0 && (
          <div className="flex aspect-square items-center justify-center rounded-md border border-border bg-muted text-sm font-medium text-muted-foreground">
            +{hiddenCount}
          </div>
        )}
      </div>
      <PhotoViewer
        images={shown}
        index={preview}
        onIndexChange={setPreview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        detailLink={(image) => ({ shortcode: image.id })}
      />
    </>
  );
}
