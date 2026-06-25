import type { EntityImage } from "@cubby/schemas/entity";
import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
} from "@cubby/schemas/image";
import { useMutation } from "@tanstack/react-query";
import { Camera, Link, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Grid } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";

export interface PendingImage {
  id: string;
  url: string;
  filename: string;
  key: string;
}

const EMPTY_IMAGES: PendingImage[] = [];

interface PendingImageUploadProps {
  entityType: EntityImage;
  onImagesChange?: (images: PendingImage[]) => void;
  existingImages?: PendingImage[]; // Existing images passed from parent component
  onExistingImagesRemove?: (removedImageIds: string[]) => void; // Track removed existing images
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
  className = "",
  autoImportUrl,
}: PendingImageUploadProps) {
  const imageInputId = useId();
  const [uploading, setUploading] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [currentExistingImages, setCurrentExistingImages] = useState<
    PendingImage[]
  >([]);
  const [removedExistingImageIds, setRemovedExistingImageIds] = useState<
    string[]
  >([]);

  const [imageUrl, setImageUrl] = useState("");
  const [importing, setImporting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const api = useTRPC();

  // Sync state from prop during render (React recommended pattern)
  const [prevExistingImages, setPrevExistingImages] = useState(existingImages);
  if (existingImages !== prevExistingImages) {
    setPrevExistingImages(existingImages);
    setCurrentExistingImages(existingImages);
  }

  // tRPC mutation for initiating an upload
  const uploadImageMutation = useMutation(
    api.image.uploadImage.mutationOptions({
      onError: (error) => {
        toast.error(`Upload initialization failed: ${getErrorMessage(error)}`);
      },
    }),
  );

  // tRPC mutation for importing from URL
  const importFromUrlMutation = useMutation(
    api.image.importFromUrl.mutationOptions({
      onError: (error) => {
        toast.error(`Import failed: ${error.message}`);
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

  // Handle importing an image from the manual URL input.
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

  // Upload a file (used by both file input and camera)
  const uploadFile = useCallback(
    async (file: File) => {
      if (!file) {
        toast.error("No file to upload");
        return null;
      }

      setUploading(true);

      try {
        // Validate content type before uploading
        if (!ALLOWED_IMAGE_TYPES.includes(file.type as AllowedImageType)) {
          toast.error(
            `Unsupported image type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP, HEIC.`,
          );
          return null;
        }

        // Step 1: Get a presigned URL
        const initResult = await uploadImageMutation.mutateAsync({
          filename: file.name,
          contentType: file.type as AllowedImageType,
          size: file.size,
          entityType,
        });

        // Step 2: Upload to storage
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

        // Step 3: Add image to pending images list
        const newImage: PendingImage = {
          id: initResult.imageId,
          url: initResult.url,
          filename: file.name,
          key: initResult.key,
        };

        const updatedImages = [...pendingImages, newImage];
        setPendingImages(updatedImages);

        // Notify parent component of the change
        if (onImagesChange) {
          onImagesChange(updatedImages);
        }

        // Show success message
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

  // Handle clipboard paste
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

  // Handle file upload from input
  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        toast.error("Please select a file to upload");
        return;
      }

      await uploadFile(file);

      // Reset the file inputs
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      if (cameraInputRef.current) {
        cameraInputRef.current.value = "";
      }
    },
    [uploadFile],
  );

  // Remove an image from the pending list
  const removeImage = useCallback(
    (imageId: string) => {
      const updatedImages = pendingImages.filter((img) => img.id !== imageId);
      setPendingImages(updatedImages);

      // Notify parent component of the change
      if (onImagesChange) {
        onImagesChange(updatedImages);
      }
    },
    [pendingImages, onImagesChange],
  );

  // Remove an existing image
  const removeExistingImage = useCallback(
    (imageId: string) => {
      // Update the list of removed image IDs
      const updatedRemovedIds = [...removedExistingImageIds, imageId];
      setRemovedExistingImageIds(updatedRemovedIds);

      // Remove from the displayed existing images
      const updatedExistingImages = currentExistingImages.filter(
        (img) => img.id !== imageId,
      );
      setCurrentExistingImages(updatedExistingImages);

      // Notify parent component of the change
      if (onExistingImagesRemove) {
        onExistingImagesRemove(updatedRemovedIds);
      }
    },
    [removedExistingImageIds, currentExistingImages, onExistingImagesRemove],
  );

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-2">
        <Label htmlFor={imageInputId}>Upload images</Label>
        <div className="flex gap-2">
          <Input
            ref={fileInputRef}
            id={imageInputId}
            type="file"
            accept="image/*"
            onChange={handleFileUpload}
            disabled={uploading}
            className="flex-1"
          />
          {/* Hidden input for native camera capture (opens Camera app on mobile, file picker on desktop) */}
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
            <Camera className="mr-2 h-4 w-4" />
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
            <Link className="mr-2 h-4 w-4" />
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

      {/* Pending images (newly uploaded) */}
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
                  className="h-24 w-full object-cover"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute top-1 right-1 h-6 w-6 rounded-full p-1"
                  onClick={() => removeImage(image.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </Grid>
        </div>
      )}

      {/* Existing images (already associated with entity) */}
      {currentExistingImages.length > 0 && (
        <div className="space-y-2">
          <Label>Existing images</Label>
          <Grid cols="images" gap="sm">
            {currentExistingImages.map((image) => (
              <div
                key={image.id}
                className="relative overflow-hidden rounded-md border"
              >
                <Image
                  src={image.url}
                  alt={image.filename}
                  className="h-24 w-full object-cover"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute top-1 right-1 h-6 w-6 rounded-full p-1"
                  onClick={() => removeExistingImage(image.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </Grid>
        </div>
      )}
    </div>
  );
}
