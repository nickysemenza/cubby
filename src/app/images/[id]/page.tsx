"use client";

import { useParams } from "next/navigation";
import { useTRPC } from "~/trpc/react";
import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  ProductPillLink,
  LocationPillLink,
  RecipePillLink,
} from "~/app/_components/EntityPill";
import { ImageStatusBadge } from "~/app/_components/table";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { useQuery } from "@tanstack/react-query";
import { assertNever } from "~/lib/assert";

export default function ImageDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const api = useTRPC();

  // Get image details from the API using the new getImageById endpoint
  const {
    data: imageDetails,
    isLoading,
    error,
  } = useQuery(api.image.getImageById.queryOptions({ id }));

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="flex items-center space-x-2">
          <div className="border-foreground h-4 w-4 animate-spin rounded-full border-t-2 border-b-2"></div>
          <span>Loading image details...</span>
        </div>
      </div>
    );
  }

  if (error || !imageDetails) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold">Image Not Found</h2>
          <p className="text-muted-foreground mt-2">
            The image you are looking for does not exist.
          </p>
        </div>
      </div>
    );
  }

  // Format bytes to human-readable format
  const formatBytes = (bytes: number, decimals = 2) => {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB"];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  };

  // Render entity link if associated with an entity
  const renderEntityLink = () => {
    if (
      !imageDetails.entityType ||
      !imageDetails.entityId ||
      !imageDetails.entityName
    ) {
      return (
        <span className="text-muted-foreground italic">
          Not associated with any entity
        </span>
      );
    }

    switch (imageDetails.entityType) {
      case "PRODUCT":
        return (
          <ProductPillLink
            product={{
              id: imageDetails.entityId,
              name: imageDetails.entityName,
              manufacturer: "", // We don't have this info here
            }}
          />
        );
      case "LOCATION":
        return (
          <LocationPillLink
            location={{
              id: imageDetails.entityId,
              name: imageDetails.entityName,
              type: "", // We don't have this info here
            }}
          />
        );
      case "RECIPE":
        return (
          <RecipePillLink
            recipe={{
              id: imageDetails.entityId,
              name: imageDetails.entityName,
            }}
          />
        );
      default:
        return assertNever(imageDetails.entityType);
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Image Details</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center">
            <div className="relative aspect-square w-full max-w-md overflow-hidden rounded-md border">
              <Image
                src={imageDetails.url}
                alt={imageDetails.filename}
                fill
                className="object-contain"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Image Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="text-muted-foreground text-sm font-medium">
                Filename
              </h3>
              <p className="mt-1">{imageDetails.filename}</p>
            </div>

            <div>
              <h3 className="text-muted-foreground text-sm font-medium">
                Content Type
              </h3>
              <p className="mt-1">{imageDetails.contentType}</p>
            </div>

            <div>
              <h3 className="text-muted-foreground text-sm font-medium">
                Size
              </h3>
              <p className="mt-1">{formatBytes(imageDetails.size)}</p>
            </div>

            <div>
              <h3 className="text-muted-foreground text-sm font-medium">
                Status
              </h3>
              <div className="mt-1">
                <ImageStatusBadge status={imageDetails.status} />
              </div>
            </div>

            <div>
              <h3 className="text-muted-foreground text-sm font-medium">
                Associated Entity
              </h3>
              <div className="mt-1">{renderEntityLink()}</div>
            </div>

            <div>
              <h3 className="text-muted-foreground text-sm font-medium">
                Created
              </h3>
              <p className="mt-1">
                <HoverableTimestamp timestamp={imageDetails.createdAt} />
              </p>
            </div>

            <div>
              <h3 className="text-muted-foreground text-sm font-medium">
                Last Updated
              </h3>
              <p className="mt-1">
                <HoverableTimestamp timestamp={imageDetails.updatedAt} />
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
