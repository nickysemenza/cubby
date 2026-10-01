/**
 * Picklist sentinels for a nullable column. A declaration primitive (saved
 * views name them) shared by the filter runtime.
 *
 * Double-underscored so they can't collide with anything a real option
 * carries — a uuid, an enum slug, or a user-authored tag. They never reach the
 * wire: `buildFiltersFromManifest` partitions them out and emits a
 * `presenceFilter` instead, so the runtime input schemas never see them.
 */
export const FILTER_ANY = "__any__";
export const FILTER_NONE = "__none__";
