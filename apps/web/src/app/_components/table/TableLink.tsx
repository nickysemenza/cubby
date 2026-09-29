import {
  TableRefLink,
  type TableRefLinkProps,
} from "~/components/entity/ref-link/leaf";

// TEMPORARY adapter for `entities/detail-field-renderers/**` (lane G2b's
// files): the old `variant` style prop is now `tone`. Delete this file once
// they use `EntityRefLink` (`variant="table"`) from
// `~/components/entity/entity-ref-link`.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export function TableLink(
  props: DistributiveOmit<TableRefLinkProps, "variant" | "tone"> & {
    variant?: TableRefLinkProps["tone"];
  },
) {
  return <TableRefLink {...props} variant="table" tone={props.variant} />;
}
