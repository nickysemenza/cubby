import {
  FilterRefLink,
  type FilterRefLinkProps,
} from "~/components/entity/ref-link/leaf";

// TEMPORARY adapter for `entities/detail-field-renderers/**` (lane G2b's
// files): the old `variant` (`value`/`icon`) is now `display`. Delete this
// file once they use `EntityRefLink` (`variant="filter"`) from
// `~/components/entity/entity-ref-link`.
export function EntityFilterLink(
  props: Omit<FilterRefLinkProps, "variant" | "display"> & {
    variant?: FilterRefLinkProps["display"];
  },
) {
  return <FilterRefLink {...props} variant="filter" display={props.variant} />;
}
