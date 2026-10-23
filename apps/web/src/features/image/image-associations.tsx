import type { ImageAssociation } from "@cubby/schemas/image";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { Stack } from "~/ui/layout";
import { NoneValue } from "~/ui/primitives/none-value";

const roleLabel = {
  attachment: "Attachment",
  cover: "Cover",
  logo: "Logo",
} satisfies Record<ImageAssociation["role"], string>;

function ImageAssociationLink({
  association,
  showRole,
  displayImages,
}: {
  association: ImageAssociation;
  compact?: boolean;
  showRole?: boolean;
  displayImages: ReturnType<typeof useEntityDisplayImages>;
}) {
  const { entityKind, entityId, entityName } = association;
  const displayImage =
    displayImages[entityDisplayImageKey({ entityKind, entityId })] ?? null;
  // Purchases have no name column; their label derives from the order id.
  const link =
    entityKind === "purchase" ? (
      <EntityRefLink
        displayImage={displayImage}
        entity="purchase"
        data={{ id: entityId, orderId: entityName }}
      />
    ) : (
      <EntityRefLink
        displayImage={displayImage}
        entity={entityKind}
        data={{ id: entityId, name: entityName }}
      />
    );

  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      {link}
      {showRole && (
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {roleLabel[association.role]}
        </span>
      )}
    </div>
  );
}

export function ImageAssociationLinks({
  associations,
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
          showRole={showRole}
          displayImages={displayImages}
        />
      ))}
    </Stack>
  );
}
