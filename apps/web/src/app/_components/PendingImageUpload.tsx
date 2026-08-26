import type { EntityImage } from "@cubby/schemas/entity";
import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
} from "@cubby/schemas/image";
import { useMutation } from "@tanstack/react-query";
import { Camera, ChevronLeft, ChevronRight, Link, Star, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FileDropField } from "~/components/file-upload/FileDropField";
import { Grid } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getErrorMessage } from "~/lib/error-utils";
import { imageUpload } from "~/lib/image.functions";
import { cn } from "~/lib/utils";

export interface PendingImage {
  id: string;
  url: string;
  filename: string;
  key: string;
}

const EMPTY_IMAGES: PendingImage[] = [];
const ACCEPTED_IMAGE_TYPES = ALLOWED_IMAGE_TYPES.join(",");

interface PendingImageUploadProps {
  entityType: EntityImage;
  onImagesChange?: (images: PendingImage[]) => void;
  existingImages?: PendingImage[];
  onExistingImagesRemove?: (removedImageIds: string[]) => void;
  // Report the full display order of the remaining existing images after a
  // reorder (first = cover). Reorder controls render only when provided.
  onExistingImagesReorder?: (orderedImageIds: string[]) => void;
  className?: string;
  // When set, automatically import this URL once (e.g. an image found by the
  // recipe scraper). Re-imports only when the value changes to a new URL.
  autoImportUrl?: string | null;
}

export function PendingImageUpload({
  entityType,
  onImagesChange,
  existingImages = EMPTY_IMAGES,
  onExistingImagesRemove,
  onExistingImagesReorder,
  className = "",
  autoImportUrl,
}: PendingImageUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  // Must seed from the prop: the sync guard below also starts at the prop, so
  // an empty initial value here would never be replaced until the prop's
  // IDENTITY changes (a refetch) — existing images would render as none.
  const [currentExistingImages, setCurrentExistingImages] =
    useState<PendingImage[]>(existingImages);
  const [removedExistingImageIds, setRemovedExistingImageIds] = useState<
    string[]
  >([]);

  const [imageUrl, setImageUrl] = useState("");
  const [importing, setImporting] = useState(false);

  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Sync state from prop during render (React recommended pattern). A new
  // prop reference means the parent refetched — drop stale local removals too.
  const [prevExistingImages, setPrevExistingImages] = useState(existingImages);
  if (existingImages !== prevExistingImages) {
    setPrevExistingImages(existingImages);
    setCurrentExistingImages(existingImages);
    setRemovedExistingImageIds([]);
  }

  const uploadImageMutation = useMutation(
    imageUpload.uploadImage.mutationOptions({
      onError: (error) => {
        toast.error(`Upload initialization failed: ${getErrorMessage(error)}`);
      },
    }),
  );

  const importFromUrlMutation = useMutation(
    imageUpload.importFromUrl.mutationOptions({
      onError: (error) => {
        toast.error(`Import failed: ${getErrorMessage(error)}`);
      },
    }),
  );

  // Import an image from an explicit URL (shared by the manual input and the
  // scraper auto-import).
  const importUrl = useCallback(
    async (rawUrl: string, { silent = false }: { silent?: boolean } = {}) => {
      const trimmed = rawUrl.trim();
      if (!trimmed) return;

      try {
        new URL(trimmed);
      } catch {
        if (!silent) toast.error("Please enter a valid URL");
        return;
      }

      setImporting(true);
      try {
        const result = await importFromUrlMutation.mutateAsync({
          url: trimmed,
          entityType,
        });

        const newImage: PendingImage = {
          id: result.imageId,
          url: result.url,
          filename: result.filename,
          key: result.key,
        };

        const updatedImages = [...pendingImages, newImage];
        setPendingImages(updatedImages);
        onImagesChange?.(updatedImages);
        setImageUrl("");
        toast.success("Photo added.");
      } catch (error) {
        toast.error(`Import failed: ${getErrorMessage(error)}`);
      } finally {
        setImporting(false);
      }
    },
    [entityType, importFromUrlMutation, pendingImages, onImagesChange],
  );

  const handleImportFromUrl = useCallback(
    () => importUrl(imageUrl),
    [importUrl, imageUrl],
  );

  // Auto-import a scraper-provided image URL once per distinct value. Failures
  // are silent here — the recipe is the primary import; the image is best-effort.
  const [autoImported, setAutoImported] = useState<string | null>(null);
  useEffect(() => {
    if (autoImportUrl && autoImportUrl !== autoImported) {
      setAutoImported(autoImportUrl);
      void importUrl(autoImportUrl, { silent: true });
    }
  }, [autoImportUrl, autoImported, importUrl]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!file) {
        toast.error("No file to upload");
        return null;
      }

      setUploading(true);

      try {
        if (!ALLOWED_IMAGE_TYPES.includes(file.type as AllowedImageType)) {
          toast.error(
            `Unsupported image type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP, HEIC.`,
          );
          return null;
        }

        const initResult = await uploadImageMutation.mutateAsync({
          filename: file.name,
          contentType: file.type as AllowedImageType,
          size: file.size,
          entityType,
        });

        const uploadResult = await fetch(initResult.uploadUrl, {
          method: "PUT",
          body: file,
          headers: {
            "Content-Type": file.type,
          },
        });

        if (!uploadResult.ok) {
          const errorText = await uploadResult
            .text()
            .catch(() => "Unknown error");
          throw new Error(
            `Storage error (${uploadResult.status}): ${errorText}`,
          );
        }

        const newImage: PendingImage = {
          id: initResult.imageId,
          url: initResult.url,
          filename: file.name,
          key: initResult.key,
        };

        const updatedImages = [...pendingImages, newImage];
        setPendingImages(updatedImages);

        if (onImagesChange) {
          onImagesChange(updatedImages);
        }

        toast.success("Photo added.");

        return newImage;
      } catch (error) {
        console.error("Upload error:", error);
        toast.error(`Upload failed: ${getErrorMessage(error)}`);
        return null;
      } finally {
        setUploading(false);
      }
    },
    [entityType, uploadImageMutation, pendingImages, onImagesChange],
  );

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (uploading || importing) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;

          e.preventDefault();

          const extension = item.type.split("/")[1] || "png";
          const namedFile = new File(
            [file],
            `pasted-image-${Date.now()}.${extension}`,
            { type: file.type },
          );

          uploadFile(namedFile);
          return;
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [uploadFile, uploading, importing]);

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        toast.error("Please select a file to upload");
        return;
      }

      await uploadFile(file);

      if (cameraInputRef.current) {
        cameraInputRef.current.value = "";
      }
    },
    [uploadFile],
  );

  const handleSelectedImages = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (file) void uploadFile(file);
    },
    [uploadFile],
  );

  const removeImage = useCallback(
    (imageId: string) => {
      const updatedImages = pendingImages.filter((img) => img.id !== imageId);
      setPendingImages(updatedImages);

      if (onImagesChange) {
        onImagesChange(updatedImages);
      }
    },
    [pendingImages, onImagesChange],
  );

  const removeExistingImage = useCallback(
    (imageId: string) => {
      const updatedRemovedIds = [...removedExistingImageIds, imageId];
      setRemovedExistingImageIds(updatedRemovedIds);

      const updatedExistingImages = currentExistingImages.filter(
        (img) => img.id !== imageId,
      );
      setCurrentExistingImages(updatedExistingImages);

      if (onExistingImagesRemove) {
        onExistingImagesRemove(updatedRemovedIds);
      }
    },
    [removedExistingImageIds, currentExistingImages, onExistingImagesRemove],
  );

  const moveExistingImage = useCallback(
    (imageId: string, target: "front" | "left" | "right") => {
      const idx = currentExistingImages.findIndex((img) => img.id === imageId);
      if (idx === -1) return;
      const next = [...currentExistingImages];
      const [moved] = next.splice(idx, 1);
      if (!moved) return;
      const to =
        target === "front"
          ? 0
          : target === "left"
            ? Math.max(0, idx - 1)
            : Math.min(next.length, idx + 1);
      next.splice(to, 0, moved);
      setCurrentExistingImages(next);
      onExistingImagesReorder?.(next.map((img) => img.id));
    },
    [currentExistingImages, onExistingImagesReorder],
  );

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <FileDropField
              accept={ACCEPTED_IMAGE_TYPES}
              label="Choose image"
              description="or drop it here"
              mode="compact"
              onFilesAdded={handleSelectedImages}
              disabled={uploading || importing}
            />
          </div>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileUpload}
            disabled={uploading}
            hidden
          />
          <Button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={uploading}
          >
            <Camera className="mr-2 size-4" />
            Camera
          </Button>
        </div>
        <div className="flex gap-2">
          <Input
            type="url"
            placeholder="Paste image URL..."
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleImportFromUrl();
              }
            }}
            disabled={importing || uploading}
            className="flex-1"
          />
          <Button
            type="button"
            onClick={handleImportFromUrl}
            disabled={importing || uploading || !imageUrl.trim()}
          >
            <Link className="mr-2 size-4" />
            Import
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          You can also paste an image from your clipboard
        </p>
      </div>

      {(uploading || importing) && (
        <div className="py-2 text-center">
          <div className="mb-2">
            {importing ? "Importing..." : "Uploading..."}
          </div>
          <div className="mx-auto h-1 w-full max-w-md rounded-full bg-muted">
            <div
              className="h-1 animate-pulse rounded-full bg-primary"
              style={{ width: "100%" }}
            ></div>
          </div>
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="space-y-2">
          <Label>New images</Label>
          <Grid cols="images" gap="sm">
            {pendingImages.map((image) => (
              <div
                key={image.id}
                className="relative overflow-hidden rounded-md border"
              >
                <Image
                  src={image.url}
                  alt={image.filename}
                  displayWidth={200}
                  className="h-24 w-full object-cover"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute top-1 right-1 size-6 rounded-full p-1"
                  onClick={() => removeImage(image.id)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </Grid>
        </div>
      )}

      {currentExistingImages.length > 0 && (
        <div className="space-y-2">
          <Label>Existing images</Label>
          <Grid cols="images" gap="sm">
            {currentExistingImages.map((image, index) => (
              <div
                key={image.id}
                className="relative overflow-hidden rounded-md border"
              >
                <Image
                  src={image.url}
                  alt={image.filename}
                  displayWidth={200}
                  className="h-24 w-full object-cover"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute top-1 right-1 size-6 rounded-full p-1"
                  onClick={() => removeExistingImage(image.id)}
                >
                  <X className="size-4" />
                </Button>
                {onExistingImagesReorder && index === 0 && (
                  <span className="absolute bottom-1 left-1 rounded-sm bg-background/80 px-1 font-mono text-2xs text-foreground uppercase">
                    Cover
                  </span>
                )}
                {onExistingImagesReorder && index > 0 && (
                  <div className="absolute bottom-1 left-1 flex gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-6 rounded-full p-1"
                      title="Make cover"
                      onClick={() => moveExistingImage(image.id, "front")}
                    >
                      <Star className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-6 rounded-full p-1"
                      title="Move earlier"
                      onClick={() => moveExistingImage(image.id, "left")}
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    {index < currentExistingImages.length - 1 && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="size-6 rounded-full p-1"
                        title="Move later"
                        onClick={() => moveExistingImage(image.id, "right")}
                      >
                        <ChevronRight className="size-4" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </Grid>
        </div>
      )}
    </div>
  );
}
