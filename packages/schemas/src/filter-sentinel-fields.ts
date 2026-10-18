/**
 * Column-filter tokens beside a value filter's picked values. A declaration
 * primitive (saved views name them) shared by the filter runtime.
 *
 * Double-underscored so they can't collide with anything a real option
 * carries — a uuid, an enum slug, or a user-authored tag. They never reach the
 * wire: `buildFiltersFromManifest` partitions them out and emits the filter's
 * generated keys instead — Any value / No value as its `presenceFilter`, Match
 * all as its match key, an excluded value as its Exclude key — so the runtime
 * input schemas never see them.
 */
export const FILTER_ANY = "__any__";
export const FILTER_NONE = "__none__";
export const FILTER_ALL = "__all__";
/** A hierarchical reference's "Include sub-…" toggle switched off. */
export const FILTER_EXACT = "__exact__";
/**
 * Marks an excluded value ("is not") in a value filter's list; the codecs
 * move it to the filter's generated Exclude key.
 */
export const FILTER_NOT_PREFIX = "__not__:";
/** The excluded value a list item names, or undefined for an included one. */
export const excludedFilterValue = (value: string): string | undefined =>
  value.startsWith(FILTER_NOT_PREFIX)
    ? value.slice(FILTER_NOT_PREFIX.length)
    : undefined;

/** The separator a value list's URL param and typed entry share. */
export const FILTER_LIST_SEPARATOR = ",";

/**
 * A comma-separated value list as its values: trimmed, empties dropped. The
 * URL codec, typed entry, and server-filter builder all read lists through
 * this, so `ext-a, ext-b` is the same two values however it arrived.
 */
export const splitFilterList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(FILTER_LIST_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);

/** A value list split into its included and excluded ("is not") values. */
export const splitExcluded = (values: readonly string[]) => {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const value of values) {
    const item = excludedFilterValue(value);
    if (item === undefined) included.push(value);
    else excluded.push(item);
  }
  return { included, excluded };
};
