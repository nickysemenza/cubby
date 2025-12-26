"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "~/trpc/react";
import type { EntityImage } from "~/entities/types";
import { X, Camera } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import Webcam from "react-webcam";
import { cn } from "~/lib/utils";
import { ImageGrid } from "~/components/media/image-grid";

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
  const [isCameraOpen, setIsCameraOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const webcamRef = useRef<Webcam>(null);
  const api = useTRPC();

  // Initialize existing images from props
  useEffect(() => {
    setCurrentExistingImages(existingImages);
  }, [existingImages]);

  // Camera configuration
  const videoConstraints = {
    width: 1280,
    height: 720,
    facingMode: "environment",
  };

  // tRPC mutation for initiating an upload
  const uploadImageMutation = useMutation(
    api.image.uploadImage.mutationOptions({
      onError: (error) => {
        toast.error(`Upload initialization failed: ${error.message}`);
      },
    }),
  );

  // Open camera dialog
  const openCamera = useCallback(() => {
    setIsCameraOpen(true);
  }, []);

  // Close camera dialog
  const closeCamera = useCallback(() => {
    setIsCameraOpen(false);
  }, []);

  // Upload a file (used by both file input and camera)
  const uploadFile = useCallback(
    async (file: File) => {
      if (!file) {
        toast.error("No file to upload");
        return null;
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

        return newImage;
      } catch (error) {
        console.error("Upload error:", error);
        toast.error("Failed to upload image. Please try again.");
        return null;
      } finally {
        setUploading(false);
      }
    },
    [entityType, uploadImageMutation, pendingImages, onImagesChange],
  );

  // Capture photo using react-webcam
  const capturePhoto = useCallback(async () => {
    if (!webcamRef.current) return;

    try {
      // Get screenshot as base64
      const imageSrc = webcamRef.current.getScreenshot();
      if (!imageSrc) {
        toast.error("Failed to capture image");
        return;
      }

      // Convert base64 to blob
      const base64Data = imageSrc.split(",")[1];
      const byteCharacters = atob(base64Data);
      const byteArrays = [];

      for (let i = 0; i < byteCharacters.length; i += 512) {
        const slice = byteCharacters.slice(i, i + 512);
        const byteNumbers = new Array(slice.length);

        for (let j = 0; j < slice.length; j++) {
          byteNumbers[j] = slice.charCodeAt(j);
        }

        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
      }

      const blob = new Blob(byteArrays, { type: "image/jpeg" });

      // Create a File object from the blob
      const filename = `camera-capture-${Date.now()}.jpg`;
      const file = new File([blob], filename, { type: "image/jpeg" });

      // Upload the captured image
      await uploadFile(file);

      // Close the camera
      closeCamera();
    } catch (error) {
      console.error("Error capturing photo:", error);
      toast.error("Failed to capture photo");
    }
  }, [uploadFile, closeCamera]);

  // Handle file upload from input
  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        toast.error("Please select a file to upload");
        return;
      }

      await uploadFile(file);

      // Reset the file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
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
        <Label htmlFor="image">Upload images</Label>
        <div className="flex gap-2">
          <Input
            ref={fileInputRef}
            id="image"
            type="file"
            accept="image/*"
            onChange={handleFileUpload}
            disabled={uploading}
            className="flex-1"
          />
          <Button type="button" onClick={openCamera} disabled={uploading}>
            <Camera className="mr-2 h-4 w-4" />
            Camera
          </Button>
        </div>
      </div>

      {/* Camera Dialog */}
      <Dialog
        open={isCameraOpen}
        onOpenChange={(open) => !open && closeCamera()}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Take a photo</DialogTitle>
          </DialogHeader>
          <div className="relative aspect-video overflow-hidden rounded-md bg-black">
            <Webcam
              audio={false}
              ref={webcamRef}
              screenshotFormat="image/jpeg"
              videoConstraints={videoConstraints}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="mt-2 flex justify-center">
            <Button onClick={capturePhoto}>Capture</Button>
          </div>
        </DialogContent>
      </Dialog>

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
          <ImageGrid variant="images">
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
          </ImageGrid>
        </div>
      )}

      {/* Existing images (already associated with entity) */}
      {currentExistingImages.length > 0 && (
        <div className="space-y-2">
          <Label>Existing images</Label>
          <ImageGrid variant="images">
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
          </ImageGrid>
        </div>
      )}
    </div>
  );
}
