import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";

import { isBrowserRoutedEntity } from "~/entity/entities";

import { EntityPill } from "./entity-pill";
import { ByIdRefLink } from "./ref-link/by-id";
import { InlineRefLink, type InlineRefLinkProps } from "./ref-link/inline";
import { ChipRefLink } from "./ref-link/leaf";

// These are navigation actions or composition boundaries, not record appearances.
export {
  AuditRefLink as EntityAuditLink,
  FilterRefLink as EntityFilterLink,
  OrderRefLink as VendorOrderLink,
  TableRefLink as EntityRouteLink,
} from "./ref-link/leaf";
export { ListRefLink as EntityRefList } from "./ref-link/list";

type RecordLinkProps = {
  entity: Entity;
  id: string;
  name?: string | null;
  displayImage?: ImageUrlSummary | null;
  emoji?: string | null;
  bare?: boolean;
  className?: string;
};

/** Image-or-mark pill by default. `bare` keeps only the linked name. */
export function EntityRefLink(props: InlineRefLinkProps): React.ReactElement;
export function EntityRefLink(props: RecordLinkProps): React.ReactElement;
export function EntityRefLink(props: InlineRefLinkProps | RecordLinkProps) {
  if ("data" in props) return <InlineRefLink {...props} />;
  if (
    (isBrowserRoutedEntity(props.entity) || props.entity === "usda-food") &&
    props.name &&
    props.name !== props.id
  )
    return <ChipRefLink {...props} entity={props.entity} name={props.name} />;
  if (props.name && props.name !== props.id)
    return props.bare ? (
      <span>{props.name}</span>
    ) : (
      <EntityPill
        entity={props.entity}
        id={props.id}
        name={props.name}
        displayImage={props.displayImage ?? null}
        emoji={props.emoji}
      />
    );
  return (
    <ByIdRefLink
      entityKind={props.entity}
      entityId={props.id}
      bare={props.bare}
    />
  );
}
