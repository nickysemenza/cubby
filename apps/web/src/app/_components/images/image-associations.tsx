import type { ImageAssociation } from "@cubby/schemas/image";
import { match } from "ts-pattern";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityRefLink } from "~/components/entity/entity-ref-link";
import { Stack } from "~/components/layout";
import { NoneValue } from "~/components/ui/none-value";

const roleLabel = {
  attachment: "Attachment",
  cover: "Cover",
  logo: "Logo",
} satisfies Record<ImageAssociation["role"], string>;

function ImageAssociationLink({
  association,
  compact,
  showRole,
  displayImages,
}: {
  association: ImageAssociation;
  compact?: boolean;
  showRole?: boolean;
  displayImages: ReturnType<typeof useEntityDisplayImages>;
}) {
  const displayImage =
    displayImages[
      entityDisplayImageKey({
        entityKind: association.entityKind,
        entityId: association.entityId,
      })
    ] ?? null;
  const link = match(association)
    .with({ entityKind: "product" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="product"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "location" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="location"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "recipe" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="recipe"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "cookbook" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="cookbook"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "project" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="project"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "purchase" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="purchase"
        data={{ id: entityId, orderId: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "vendor" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="vendor"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "meal" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="meal"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "task" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="task"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityKind: "gardenEntry" }, ({ entityId, entityName }) => (
      <EntityRefLink
        displayImage={displayImage}
        entity="gardenEntry"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .exhaustive();

  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      {link}
      {showRole && (
        <span className="shrink-0 font-mono text-2xs text-muted-foreground uppercase">
          {roleLabel[association.role]}
        </span>
      )}
    </div>
  );
}

export function ImageAssociationLinks({
  associations,
  compact,
  showRole,
}: {
  associations: ImageAssociation[];
  compact?: boolean;
  showRole?: boolean;
}) {
  const refs = associations.map(({ entityKind, entityId }) => ({
    entityKind,
    entityId,
  }));
  const displayImages = useEntityDisplayImages(refs);

  if (associations.length === 0) return <NoneValue />;

  return (
    <Stack gap="xs" className="min-w-0">
      {associations.map((association) => (
        <ImageAssociationLink
          key={`${association.entityKind}:${association.entityId}:${association.role}`}
          association={association}
          compact={compact}
          showRole={showRole}
          displayImages={displayImages}
        />
      ))}
    </Stack>
  );
}
