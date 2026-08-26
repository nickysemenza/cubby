import type { ImageWithEntity } from "@cubby/schemas/image";
import { ImageIcon, Info, Link2 } from "lucide-react";
import prettyBytes from "pretty-bytes";
import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import {
  type DetailSection,
  DetailSections,
} from "~/app/_components/data-table/detail-page";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { imageStatusOptions } from "~/app/images/image-options";
import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { Image } from "~/components/ui/image";
import { image as imageOperations } from "~/entities/image.functions";
import { EditableCell } from "../data-table/editable-cell";
import { useUpdateMutation } from "../hooks/useUpdateMutation";

interface ImageDetailProps {
  image: ImageWithEntity;
}

/** The record's media, shared by the phone hero and desktop detail rail. */
export function ImageDetailMedia({ image }: ImageDetailProps) {
  return (
    <div className="relative aspect-square w-full overflow-hidden border-border border-y bg-card md:max-w-sm md:rounded-md md:border">
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
  );
}

export function ImageDetail({ image }: ImageDetailProps) {
  const updateMutation = useUpdateMutation({
    mutationFn: () => imageOperations.update.mutationOptions(),
    entity: "image",
  });

  const sections: DetailSection[] = [
    {
      id: "associations",
      title: "Associations",
      icon: Link2,
      placement: "primary",
      content:
        image.associations.length > 0 ? (
          <ImageAssociationLinks associations={image.associations} showRole />
        ) : (
          <Description>This image is not attached to a record.</Description>
        ),
    },
    {
      id: "metadata",
      title: "Metadata",
      icon: Info,
      placement: "supporting",
      content: (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Filename</dt>
          <dd className="min-w-0">
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
              renderValue={(value) => value}
            />
          </dd>
          <dt className="text-muted-foreground">Type</dt>
          <dd className="min-w-0 break-all font-mono text-xs">
            {image.contentType}
          </dd>
          <dt className="text-muted-foreground">Size</dt>
          <dd>{prettyBytes(image.size)}</dd>
          <dt className="text-muted-foreground">Dimensions</dt>
          <dd>
            {image.width && image.height
              ? `${image.width} × ${image.height}`
              : "—"}
          </dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <Row align="center" gap="sm">
              {renderOptionCell(image.status, imageStatusOptions)}
              <EntityFilterLink
                to="/images"
                search={{ status: image.status }}
                label={`Show all ${image.status.toLowerCase()} images`}
              />
            </Row>
          </dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>
            <HoverableTimestamp timestamp={image.createdAt} />
          </dd>
        </dl>
      ),
    },
  ];

  return (
    <DetailSections
      sections={sections}
      rawData={image}
      heroMedia={<ImageDetailMedia image={image} />}
    />
  );
}
