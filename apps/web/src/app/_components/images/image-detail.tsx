import type { ImageStatus } from "@cubby/schemas/image";
import { ImageIcon } from "lucide-react";
import { EntityPillLink } from "~/app/_components/EntityPill";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Image } from "~/components/ui/image";
import { assertNever } from "~/lib/assert";
import { formatBytes } from "~/lib/format";

interface ImageData {
  id: string;
  filename: string;
  url: string;
  contentType: string;
  size: number;
  status: ImageStatus;
  entityType: "PRODUCT" | "LOCATION" | "RECIPE" | "COOKBOOK" | null;
  entityId: string | null;
  entityName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ImageDetailProps {
  image: ImageData;
}

export function ImageDetail({ image }: ImageDetailProps) {
  const renderEntityLink = () => {
    if (!image.entityType || !image.entityId || !image.entityName) {
      return (
        <span className="text-muted-foreground italic">
          Not associated with any entity
        </span>
      );
    }

    switch (image.entityType) {
      case "PRODUCT":
        return (
          <EntityPillLink
            entity="product"
            data={{
              id: image.entityId,
              name: image.entityName,
              manufacturer: "",
            }}
          />
        );
      case "LOCATION":
        return (
          <EntityPillLink
            entity="location"
            data={{ id: image.entityId, name: image.entityName, type: "room" }}
          />
        );
      case "RECIPE":
        return (
          <EntityPillLink
            entity="recipe"
            data={{ id: image.entityId, name: image.entityName }}
          />
        );
      case "COOKBOOK":
        // Cookbook covers are tracked by FK, not the join-table ownership this
        // view resolves, so entityId/entityName are unset and the guard above
        // returns first — this case exists only for exhaustiveness.
        return (
          <a
            href={`/cookbooks/${image.entityId}`}
            className="font-medium text-sm hover:underline"
          >
            {image.entityName}
          </a>
        );
      default:
        return assertNever(image.entityType);
    }
  };

  return (
    <div className="space-y-4">
      {/* Preview */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Preview</CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center">
          <div className="relative aspect-square w-full max-w-xs overflow-hidden rounded-md border">
            {image.status === "UPLOADED" ? (
              <Image
                src={image.url}
                alt={image.filename}
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-muted/30">
                <div className="text-center">
                  <ImageIcon className="mx-auto h-12 w-12 text-muted-foreground/50" />
                  <p className="mt-2 text-muted-foreground text-sm">
                    {image.status === "PENDING"
                      ? "Upload pending..."
                      : "Upload failed"}
                  </p>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Info */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">Filename:</span>{" "}
            {image.filename}
          </div>
          <div>
            <span className="text-muted-foreground">Type:</span>{" "}
            {image.contentType}
          </div>
          <div>
            <span className="text-muted-foreground">Size:</span>{" "}
            {formatBytes(image.size)}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Status:</span>
            <ImageStatusBadge status={image.status} />
          </div>
          <div>
            <span className="text-muted-foreground">Entity:</span>{" "}
            {renderEntityLink()}
          </div>
          <div>
            <span className="text-muted-foreground">Created:</span>{" "}
            <HoverableTimestamp timestamp={image.createdAt} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
