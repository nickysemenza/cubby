import type { ImageWithEntity } from "@cubby/schemas/image";
import { Link } from "@tanstack/react-router";
import { ImageIcon } from "lucide-react";
import prettyBytes from "pretty-bytes";
import { match } from "ts-pattern";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { Row, Stack } from "~/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { imageMutationInvalidateKeys, queryKeys } from "~/lib/query-keys";
import { EditableCell } from "../data-table/editable-cell";
import { useEntityDelete } from "../hooks/useEntityDelete";
import { useUpdateMutation } from "../hooks/useUpdateMutation";

/** Module-level so the delete hook's key list keeps a stable identity. */
const IMAGE_INVALIDATE_KEYS = [queryKeys.image.list] as const;

interface ImageDetailProps {
  image: ImageWithEntity;
}

export function ImageDetail({ image }: ImageDetailProps) {
  const api = useTRPC();

  const updateMutation = useUpdateMutation({
    mutationFn: api.image.update.mutationOptions,
    entity: "image",
    invalidateKeys: imageMutationInvalidateKeys,
  });

  // Images DO have a `deletedAt` column (like every other entity), but
  // `deleteImages` intentionally hard-deletes anyway — see its doc comment in
  // server/repo/image.ts. Restore was never implemented for any entity, and an
  // orphaned image (no owning product/location/recipe/project) has no use
  // once removed, so this really removes the row and its R2 object; any
  // owning entity just loses the picture.
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: image.id,
    name: image.filename,
    entityLabel: "Image",
    entity: "image",
    mutationOptions: (callbacks) => api.image.delete.mutationOptions(callbacks),
    invalidateKeys: IMAGE_INVALIDATE_KEYS,
    redirectTo: "/images",
  });

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
        <EntityInlineLink
          entity="product"
          data={{
            id: entityId,
            name: entityName,
            manufacturer: "",
          }}
        />
      ))
      .with("LOCATION", () => (
        <EntityInlineLink
          entity="location"
          data={{
            id: entityId,
            name: entityName,
            type: "room",
          }}
        />
      ))
      .with("RECIPE", () => (
        <EntityInlineLink
          entity="recipe"
          data={{ id: entityId, name: entityName }}
        />
      ))
      .with("PROJECT", () => (
        <Link
          to={entities.project.routes.detail}
          params={entityDetailParams(entityId)}
          className="font-medium text-sm hover:underline"
        >
          {entityName}
        </Link>
      ))
      .with("COOKBOOK", () => (
        // Cookbook covers are tracked by FK, not the join-table ownership this
        // view resolves, so entityId/entityName are unset and the guard above
        // returns first — this case exists only for exhaustiveness.
        <Link
          to={entities.cookbook.routes.detail}
          params={entityDetailParams(entityId)}
          className="font-medium text-sm hover:underline"
        >
          {entityName}
        </Link>
      ))
      .with("PURCHASE", () => (
        <Link
          to={entities.purchase.routes.detail}
          params={entityDetailParams(entityId)}
          className="font-medium text-sm hover:underline"
        >
          {entityName}
        </Link>
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
                  <ImageIcon className="mx-auto size-12 text-muted-foreground/50" />
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
            <EditableCell
              value={image.filename}
              config={{ type: "text" }}
              onSave={async (filename) => {
                if (!filename) return;
                await updateMutation.mutateAsync({
                  id: image.id,
                  data: { filename },
                });
              }}
              renderValue={(v) => v}
            />
          </div>
          <div>
            <span className="text-muted-foreground">Type:</span>{" "}
            {image.contentType}
          </div>
          <div>
            <span className="text-muted-foreground">Size:</span>{" "}
            {prettyBytes(image.size)}
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
          <Row justify="end">{deleteButton}</Row>
        </CardContent>
      </Card>

      {deleteDialog}
    </Stack>
  );
}
