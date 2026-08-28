import type { ImageAssociation } from "@cubby/schemas/image";
import { match } from "ts-pattern";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
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
}: {
  association: ImageAssociation;
  compact?: boolean;
  showRole?: boolean;
}) {
  const link = match(association)
    .with({ entityType: "product" }, ({ entityId, entityName }) => (
      <EntityInlineLink
        displayImage={undefined}
        entity="product"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityType: "location" }, ({ entityId, entityName }) => (
      <EntityInlineLink
        displayImage={undefined}
        entity="location"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityType: "recipe" }, ({ entityId, entityName }) => (
      <EntityInlineLink
        displayImage={undefined}
        entity="recipe"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityType: "cookbook" }, ({ entityId, entityName }) => (
      <EntityInlineLink
        displayImage={undefined}
        entity="cookbook"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityType: "project" }, ({ entityId, entityName }) => (
      <EntityInlineLink
        displayImage={undefined}
        entity="project"
        data={{ id: entityId, name: entityName }}
        compact={compact}
      />
    ))
    .with({ entityType: "purchase" }, ({ entityId, entityName }) => (
      <EntityInlineLink
        displayImage={undefined}
        entity="purchase"
        data={{ id: entityId, orderId: entityName }}
        compact={compact}
      />
    ))
    .with({ entityType: "vendor" }, ({ entityId, entityName }) => (
      <EntityInlineLink
        displayImage={undefined}
        entity="vendor"
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
  if (associations.length === 0) return <NoneValue />;

  return (
    <Stack gap="xs" className="min-w-0">
      {associations.map((association) => (
        <ImageAssociationLink
          key={`${association.entityType}:${association.entityId}:${association.role}`}
          association={association}
          compact={compact}
          showRole={showRole}
        />
      ))}
    </Stack>
  );
}
