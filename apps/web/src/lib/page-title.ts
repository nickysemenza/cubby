/**
 * The one place the browser-tab title is assembled.
 *
 * Titles reach the tab by two different routes and they must agree:
 *  - `head: () => ({ meta: [{ title }] })` on a route, rendered by TanStack's
 *    `HeadContent` as a real React `<title>` element. Server-rendered, so it is
 *    correct on first paint.
 *  - `useDocumentTitle`, which writes `document.title` imperatively — the only
 *    option for `ssr: false` detail routes whose name arrives from a client
 *    query.
 *
 * Both funnel through {@link pageTitle} so the suffix can never drift between
 * them (it used to be a literal in 39 route files plus a default parameter).
 */

/** Trailing brand segment on every title. */
const TITLE_SUFFIX = "cubby";

/** The fallback the root route publishes when no route contributes a title. */
export const DEFAULT_TITLE = "Cubby";

/** Separator between a shortcode and the entity's name in a detail title. */
export const TITLE_SEPARATOR = " · ";

/**
 * `pageTitle("Products")` → `"Products | cubby"`.
 *
 * Empty and `undefined` parts drop out, so a caller can pass a summary that may
 * or may not exist without branching.
 */
export const pageTitle = (
  ...parts: Array<string | undefined | false>
): string =>
  [...parts.filter((part): part is string => !!part), TITLE_SUFFIX].join(" | ");

/**
 * `head` for a detail route keyed by shortcode.
 *
 * The shortcode comes from route params, so the tab is identifiable the instant
 * the route matches — no data dependency, no pending window showing the bare
 * root default. `useDetailTitle` upgrades it to `CODE · Name` once the query
 * resolves.
 *
 * Declaring the narrower context shape (rather than importing TanStack's full
 * `AssetFnContextOptions`) is deliberate and safe: a function that reads fewer
 * properties is assignable where one reading more is expected.
 */
export const shortcodeHead = ({
  params,
}: {
  params: { shortcode: string };
}) => ({
  meta: [{ title: pageTitle(params.shortcode) }],
});
