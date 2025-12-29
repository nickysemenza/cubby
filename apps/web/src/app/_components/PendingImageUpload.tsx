import { useMutation } from "@tanstack/react-query";
import { Camera, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { GridContainer } from "~/components/layout/grid-container";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { EntityImage } from "~/entities/types";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";

export interface PendingImage {
  id: string;
  url: string;
  filename: string;
  key: string;
}

interface PendingImageUploadProps {
  entityType: EntityImage;
  onImagesChange?: (images: PendingImage[]) => void;
  existingImages?: PendingImage[]; // Existing images passed from parent component
  onExistingImagesRemove?: (removedImageIds: string[]) => void; // Track removed existing images
  className?: string;
}

export function PendingImageUpload({
  entityType,
  onImagesChange,
  existingImages = [],
  onExistingImagesRemove,
  className = "",
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const api = useTRPC();

  // Initialize existing images from props
  useEffect(() => {
    setCurrentExistingImages(existingImages);
  }, [existingImages]);

  // tRPC mutation for initiating an upload
  const uploadImageMutation = useMutation(
    api.image.uploadImage.mutationOptions({
      onError: (error) => {
        toast.error(`Upload initialization failed: ${error.message}`);
      },
    }),
  );

  // Upload a file (used by both file input and camera)
  const uploadFile = useCallback(
    async (file: File) => {
      if (!file) {
        toast.error("No file to upload");
        return null;
      }

      setUploading(true);

      try {
        // Step 1: Get a presigned URL
        const initResult = await uploadImageMutation.mutateAsync({
          filename: file.name,
          contentType: file.type,
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
        toast.success("Image uploaded successfully!");

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
      </div>

      {uploading && (
        <div className="py-2 text-center">
          <div className="mb-2">Uploading...</div>
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
          <GridContainer cols="images" gap={2}>
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
          </GridContainer>
        </div>
      )}

      {/* Existing images (already associated with entity) */}
      {currentExistingImages.length > 0 && (
        <div className="space-y-2">
          <Label>Existing images</Label>
          <GridContainer cols="images" gap={2}>
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
          </GridContainer>
        </div>
      )}
    </div>
  );
}
