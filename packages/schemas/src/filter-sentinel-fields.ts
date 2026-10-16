/**
 * Column-filter tokens beside a value filter's picked values. A declaration
 * primitive (saved views name them) shared by the filter runtime.
 *
 * Double-underscored so they can't collide with anything a real option
 * carries — a uuid, an enum slug, or a user-authored tag. They never reach the
 * wire: `buildFiltersFromManifest` partitions them out and emits the filter's
 * generated keys instead — Any value / No value as its `presenceFilter`, Match
 * all as its match key — so the runtime input schemas never see them.
 */
export const FILTER_ANY = "__any__";
export const FILTER_NONE = "__none__";
export const FILTER_ALL = "__all__";
/** A hierarchical reference's "Include sub-…" toggle switched off. */
export const FILTER_EXACT = "__exact__";
