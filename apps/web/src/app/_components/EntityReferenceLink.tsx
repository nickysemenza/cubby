import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";

import { useEntityDisplayImage } from "~/app/_components/entity-media/entity-display-images";
import { EntityPreviewLink } from "~/app/_components/EntityPreviewLink";
import {
  hoverPreviewEntities,
  type HoverPreviewEntity,
} from "~/app/_components/preview/preview-entities";
import {
  TableLink,
  tableLinkVariants,
} from "~/app/_components/table/TableLink";
import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import { entities, entityDetailParams } from "~/entities/entities";

const isHoverPreviewEntity = (
  entity: BrowserRoutedEntity,
): entity is HoverPreviewEntity =>
  hoverPreviewEntities.some((candidate) => candidate === entity);

/**
 * A link to one record led by the same image-or-icon identity mark as
 * `EntityInlineLink`: manifest reference values and field-provenance sources
 * share it so a record reads the same wherever it is named. The cover is the
 * passed `displayImage`, else the nearest `EntityDisplayImagesProvider`'s;
 * outside both, the entity icon holds its box.
 */
export function EntityReferenceLink({
  entity,
  id,
  name,
  displayImage,
}: {
  entity: BrowserRoutedEntity;
  id: string;
  name: string | null;
  displayImage?: ImageUrlSummary | null;
}) {
  const label = name ?? id;
  const providedImage = useEntityDisplayImage({
    entityType: entity,
    entityId: id,
  });
  const image = displayImage ?? providedImage;
  if (isHoverPreviewEntity(entity))
    return (
      <EntityPreviewLink
        entity={entity}
        id={id}
        displayImage={image}
        className={tableLinkVariants({ className: "max-w-full min-w-0" })}
      >
        <span className="min-w-0 truncate">{label}</span>
      </EntityPreviewLink>
    );
  return (
    <TableLink
      to={entities[entity].routes.detail}
      params={entityDetailParams(id)}
      title={label}
      className="inline-flex max-w-full min-w-0 items-center gap-1"
    >
      <EntityIdentityMark entity={entity} displayImage={image} />
      <span className="min-w-0 truncate">{label}</span>
    </TableLink>
  );
}
