import { useQuery } from "@tanstack/react-query";
import { EntityPillLink } from "~/app/_components/EntityPill";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Image } from "~/components/ui/image";
import { assertNever } from "~/lib/assert";
import { useTRPC } from "~/trpc/react";

interface ImageDetailPageProps {
  id: string;
}

export default function ImageDetailPage({ id }: ImageDetailPageProps) {
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
          <div className="h-4 w-4 animate-spin rounded-full border-foreground border-t-2 border-b-2"></div>
          <span>Loading image details...</span>
        </div>
      </div>
    );
  }

  if (error || !imageDetails) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <h2 className="font-semibold text-xl">Image Not Found</h2>
          <p className="mt-2 text-muted-foreground">
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

    return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
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
          <EntityPillLink
            entity="product"
            data={{
              id: imageDetails.entityId,
              name: imageDetails.entityName,
              manufacturer: "", // We don't have this info here
            }}
          />
        );
      case "LOCATION":
        return (
          <EntityPillLink
            entity="location"
            data={{
              id: imageDetails.entityId,
              name: imageDetails.entityName,
              type: "room", // Default fallback - actual type not available in image context
            }}
          />
        );
      case "RECIPE":
        return (
          <EntityPillLink
            entity="recipe"
            data={{
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
    <PageWrapper>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="font-bold text-3xl tracking-tight">Image Details</h1>
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
                  className="absolute inset-0 h-full w-full object-contain"
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
                <h3 className="font-medium text-muted-foreground text-sm">
                  Filename
                </h3>
                <p className="mt-1">{imageDetails.filename}</p>
              </div>

              <div>
                <h3 className="font-medium text-muted-foreground text-sm">
                  Content Type
                </h3>
                <p className="mt-1">{imageDetails.contentType}</p>
              </div>

              <div>
                <h3 className="font-medium text-muted-foreground text-sm">
                  Size
                </h3>
                <p className="mt-1">{formatBytes(imageDetails.size)}</p>
              </div>

              <div>
                <h3 className="font-medium text-muted-foreground text-sm">
                  Status
                </h3>
                <div className="mt-1">
                  <ImageStatusBadge status={imageDetails.status} />
                </div>
              </div>

              <div>
                <h3 className="font-medium text-muted-foreground text-sm">
                  Associated Entity
                </h3>
                <div className="mt-1">{renderEntityLink()}</div>
              </div>

              <div>
                <h3 className="font-medium text-muted-foreground text-sm">
                  Created
                </h3>
                <p className="mt-1">
                  <HoverableTimestamp timestamp={imageDetails.createdAt} />
                </p>
              </div>

              <div>
                <h3 className="font-medium text-muted-foreground text-sm">
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
    </PageWrapper>
  );
}
