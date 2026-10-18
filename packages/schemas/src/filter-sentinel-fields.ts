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

/** The separator between a value list's items, in its URL param and typed entry. */
export const FILTER_LIST_SEPARATOR = ",";
const FILTER_LIST_ESCAPE = "\\";

/**
 * A value list as one URL param. A comma or backslash inside a value is
 * backslash-escaped, so a picked tag `quick, easy` stays one value.
 */
export const joinFilterList = (values: readonly string[]): string =>
  values
    .map((value) =>
      value
        .replaceAll(
          FILTER_LIST_ESCAPE,
          `${FILTER_LIST_ESCAPE}${FILTER_LIST_ESCAPE}`,
        )
        .replaceAll(
          FILTER_LIST_SEPARATOR,
          `${FILTER_LIST_ESCAPE}${FILTER_LIST_SEPARATOR}`,
        ),
    )
    .join(FILTER_LIST_SEPARATOR);

/**
 * A URL param back into the values {@link joinFilterList} wrote: split on
 * unescaped commas, unescaped, trimmed, empties dropped. An unescaped link
 * (`?tags=a,b`) reads as before.
 */
export const splitFilterList = (raw: string | undefined): string[] => {
  const values: string[] = [];
  let current = "";
  const text = raw ?? "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === FILTER_LIST_ESCAPE && index + 1 < text.length) {
      index += 1;
      current += text[index];
    } else if (char === FILTER_LIST_SEPARATOR) {
      values.push(current);
      current = "";
    } else current += char;
  }
  values.push(current);
  return values.map((value) => value.trim()).filter(Boolean);
};

/** Typed entry (an external id list): every comma separates two values. */
export const splitTypedList = (raw: string): string[] =>
  raw
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
