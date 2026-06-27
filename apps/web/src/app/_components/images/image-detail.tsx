import type { ImageWithEntity } from "@cubby/schemas/image-responses";
import { ImageIcon } from "lucide-react";
import { match } from "ts-pattern";
import { EntityPillLink } from "~/app/_components/EntityPill";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { Row, Stack } from "~/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { formatBytes } from "~/lib/format";

interface ImageDetailProps {
  image: ImageWithEntity;
}

export function ImageDetail({ image }: ImageDetailProps) {
  const renderEntityLink = () => {
    // Destructure to locals so the guard's narrowing survives into the match
    // closures below (property narrowing on `image` would be lost in callbacks).
    const { entityType, entityId, entityName } = image;
    if (!entityType || !entityId || !entityName) {
      return (
        <Description as="span" className="italic">
          Not associated with any entity
        </Description>
      );
    }

    return match(entityType)
      .with("PRODUCT", () => (
        <EntityPillLink
          entity="product"
          data={{
            id: entityId,
            name: entityName,
            manufacturer: "",
          }}
        />
      ))
      .with("LOCATION", () => (
        <EntityPillLink
          entity="location"
          data={{ id: entityId, name: entityName, type: "room" }}
        />
      ))
      .with("RECIPE", () => (
        <EntityPillLink
          entity="recipe"
          data={{ id: entityId, name: entityName }}
        />
      ))
      .with("COOKBOOK", () => (
        // Cookbook covers are tracked by FK, not the join-table ownership this
        // view resolves, so entityId/entityName are unset and the guard above
        // returns first — this case exists only for exhaustiveness.
        <a
          href={`/cookbooks/${entityId}`}
          className="font-medium text-sm hover:underline"
        >
          {entityName}
        </a>
      ))
      .exhaustive();
  };

  return (
    <Stack>
      {/* Preview */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Preview</CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center">
          <div className="relative aspect-square w-full max-w-xs overflow-hidden rounded-md border">
            {image.status === "UPLOADED" ? (
              <Image
                src={image.url}
                alt={image.filename}
                displayWidth={640}
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-muted/30">
                <div className="text-center">
                  <ImageIcon className="mx-auto h-12 w-12 text-muted-foreground/50" />
                  <Description className="mt-2">
                    {image.status === "PENDING"
                      ? "Upload pending..."
                      : "Upload failed"}
                  </Description>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Info */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
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
          <Row align="center" gap="sm">
            <span className="text-muted-foreground">Status:</span>
            <ImageStatusBadge status={image.status} />
          </Row>
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
    </Stack>
  );
}
