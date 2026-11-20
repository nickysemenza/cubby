import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { ReactNode } from "react";

import { isBrowserRoutedEntity } from "~/entity/entities";

import { EntityPill } from "./entity-pill";
import {
  recordFact,
  recordQualifier,
  type ReferenceRecord,
} from "./record-pill-identity";
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

type RecordLinkProps = {
  entity: Entity;
  id: string;
  name?: string | null;
  /** Hierarchy ancestors of `name`; the pill draws the leaf first. */
  parent?: string | null;
  /**
   * The row this reference came from, when the caller holds one. The pill
   * reads the entity's declared qualifier and fact off it; nothing is fetched.
   */
  record?: ReferenceRecord | null;
  /** Muted text after the title, when the caller composes it itself. */
  qualifier?: string | null;
  displayImage?: ImageUrlSummary | null;
  emoji?: string | null;
  /** The mark shown when the record has no emoji or image. */
  fallback?: ReactNode;
  bare?: boolean;
  className?: string;
};

/** Image-or-mark pill by default. `bare` keeps only the linked name. */
export function EntityRefLink(props: InlineRefLinkProps): React.ReactElement;
export function EntityRefLink(props: RecordLinkProps): React.ReactElement;
export function EntityRefLink(props: InlineRefLinkProps | RecordLinkProps) {
  if ("data" in props) return <InlineRefLink {...props} />;
  const { record, ...link } = props;
  const qualifier =
    props.qualifier ?? (record ? recordQualifier(props.entity, record) : null);
  const fact = record ? recordFact(props.entity, record) : null;
  if (
    isBrowserRoutedEntity(props.entity) &&
    props.name &&
    props.name !== props.id
  )
    return (
      <ChipRefLink
        {...link}
        entity={props.entity}
        name={props.name}
        qualifier={qualifier}
        fact={fact}
      />
    );
  if (props.name && props.name !== props.id)
    return props.bare ? (
      <span>{props.name}</span>
    ) : (
      <EntityPill
        entity={props.entity}
        id={props.id}
        name={props.name}
        parent={props.parent}
        qualifier={qualifier}
        fact={fact}
        displayImage={props.displayImage ?? null}
        emoji={props.emoji}
        fallback={props.fallback}
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
