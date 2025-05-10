"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "~/trpc/react";
import { EntityImage } from "~/entities/types";
import { X } from "lucide-react";

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
  const [uploading, setUploading] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [currentExistingImages, setCurrentExistingImages] = useState<
    PendingImage[]
  >([]);
  const [removedExistingImageIds, setRemovedExistingImageIds] = useState<
    string[]
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Handle file upload
  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      toast.error("Please select a file to upload");
      return;
    }

    try {
      setUploading(true);

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
        throw new Error("Failed to upload to storage");
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

      // Reset the file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      console.error("Upload error:", error);
      toast.error("Failed to upload image. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  // Remove an image from the pending list
  const removeImage = (imageId: string) => {
    const updatedImages = pendingImages.filter((img) => img.id !== imageId);
    setPendingImages(updatedImages);

    // Notify parent component of the change
    if (onImagesChange) {
      onImagesChange(updatedImages);
    }
  };

  // Remove an existing image
  const removeExistingImage = (imageId: string) => {
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
  };

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="space-y-2">
        <Label htmlFor="image">Upload images</Label>
        <Input
          ref={fileInputRef}
          id="image"
          type="file"
          accept="image/*"
          onChange={handleFileUpload}
          disabled={uploading}
        />
      </div>

      {uploading && (
        <div className="py-2 text-center">
          <div className="mb-2">Uploading...</div>
          <div className="mx-auto h-1 w-full max-w-md rounded-full bg-gray-200">
            <div
              className="h-1 animate-pulse rounded-full bg-blue-600"
              style={{ width: "100%" }}
            ></div>
          </div>
        </div>
      )}

      {/* Pending images (newly uploaded) */}
      {pendingImages.length > 0 && (
        <div className="space-y-2">
          <Label>New images</Label>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {pendingImages.map((image) => (
              <div
                key={image.id}
                className="relative overflow-hidden rounded-md border"
              >
                <Image
                  src={image.url}
                  alt={image.filename}
                  width={100}
                  height={100}
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
          </div>
        </div>
      )}

      {/* Existing images (already associated with entity) */}
      {currentExistingImages.length > 0 && (
        <div className="space-y-2">
          <Label>Existing images</Label>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {currentExistingImages.map((image) => (
              <div
                key={image.id}
                className="relative overflow-hidden rounded-md border"
              >
                <Image
                  src={image.url}
                  alt={image.filename}
                  width={100}
                  height={100}
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
          </div>
        </div>
      )}
    </div>
  );
}
