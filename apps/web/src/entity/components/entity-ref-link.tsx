import { ByIdRefLink, type ByIdRefLinkProps } from "./ref-link/by-id";
import { InlineRefLink, type InlineRefLinkProps } from "./ref-link/inline";
import {
  AuditRefLink,
  ChipRefLink,
  FilterRefLink,
  OrderRefLink,
  PreviewRefLink,
  TableRefLink,
  type AuditRefLinkProps,
  type ChipRefLinkProps,
  type FilterRefLinkProps,
  type OrderRefLinkProps,
  type PreviewRefLinkProps,
  type TableRefLinkProps,
} from "./ref-link/leaf";
import { ListRefLink, type ListRefLinkProps } from "./ref-link/list";

/**
 * The one way to name a record as a link.
 *
 * `variant` picks the presentation; each variant owns its own hooks and
 * behaviour, so the dispatcher only chooses which one renders.
 *
 * - `inline` (default): icon/cover mark + name + muted metadata, hover preview.
 *   Takes the entity's typed `data`; `displayImage: null` intentionally renders
 *   the mark.
 * - `chip`: mark + truncated label by `entity`/`id`; an omitted `displayImage`
 *   falls back to the surrounding `EntityDisplayImagesProvider`.
 * - `list`: a column/stack of inline links that resolves covers in one batch.
 * - `byId`: resolves a record from `entityKind`/`entityId`, then links it.
 * - `preview`: the bare link + hover card around arbitrary children.
 * - `table`: a styled route link for a table cell; stops row-click bubbling.
 * - `audit`: name + code stamp for audit rows; unrouted kinds render a span.
 * - `filter`: navigate from a facet to its filtered list.
 * - `order`: icon link out to a vendor's order page.
 */
export type EntityRefLinkProps =
  | InlineRefLinkProps
  | ChipRefLinkProps
  | ListRefLinkProps
  | ByIdRefLinkProps
  | PreviewRefLinkProps
  | TableRefLinkProps
  | AuditRefLinkProps
  | FilterRefLinkProps
  | OrderRefLinkProps;

// One overload per variant rather than a single union parameter: TypeScript
// only splits a union-typed `entity` prop into its discriminated members while
// the union stays under 25 combinations, and the inline variant alone spends
// 20 of them.
export function EntityRefLink(props: InlineRefLinkProps): React.ReactElement;
export function EntityRefLink(props: ChipRefLinkProps): React.ReactElement;
export function EntityRefLink(props: ListRefLinkProps): React.ReactElement;
export function EntityRefLink(props: ByIdRefLinkProps): React.ReactElement;
export function EntityRefLink(props: PreviewRefLinkProps): React.ReactElement;
export function EntityRefLink(props: TableRefLinkProps): React.ReactElement;
export function EntityRefLink(props: AuditRefLinkProps): React.ReactElement;
export function EntityRefLink(props: FilterRefLinkProps): React.ReactElement;
export function EntityRefLink(
  props: OrderRefLinkProps,
): React.ReactElement | null;
export function EntityRefLink(props: EntityRefLinkProps) {
  switch (props.variant) {
    case undefined:
    case "inline":
      return <InlineRefLink {...props} />;
    case "chip":
      return <ChipRefLink {...props} />;
    case "list":
      return <ListRefLink {...props} />;
    case "byId":
      return <ByIdRefLink {...props} />;
    case "preview":
      return <PreviewRefLink {...props} />;
    case "table":
      return <TableRefLink {...props} />;
    case "audit":
      return <AuditRefLink {...props} />;
    case "filter":
      return <FilterRefLink {...props} />;
    case "order":
      return <OrderRefLink {...props} />;
  }
}
