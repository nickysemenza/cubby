/**
 * The MCP App manifest — the one place an app is declared.
 *
 * `apps/web` consumes this to register `ui://` resources, and `build.mjs`
 * discovers entry points from the sibling `*.html` files, so adding an app
 * means: a `<id>.html`, a `src/<id>.ts`, and one entry below.
 *
 * The HTML is the *built* single-file bundle, inlined as a string because the
 * CF Worker has no filesystem to read it from at request time.
 */

/**
 * Built bundles, keyed by `/absolute/path/to/dist/<id>.html`.
 *
 * A glob rather than one import line per app, so the list below stays the only
 * thing to edit. It resolves at build time exactly like a static import — but
 * it yields `{}` instead of throwing when `dist/` is missing, so `bundleFor`
 * raises the error itself and keeps the failure loud. (`pnpm dev`, `test`, and
 * `build:cf` all gate on `scripts/ensure-mcp-apps.mjs`, so this should only
 * ever fire for someone wiring up a new consumer.)
 */
const BUILT = import.meta.glob<string>("../dist/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
});

function bundleFor(id: string): string {
  const entry = Object.entries(BUILT).find(([path]) =>
    path.endsWith(`/${id}.html`),
  );
  if (!entry) {
    throw new Error(
      `MCP app bundle "${id}" is missing — run \`pnpm --filter @cubby/mcp-apps build\`.`,
    );
  }
  return entry[1];
}

export type McpAppBundle = {
  /** `ui://` URI a tool's `_meta.ui.resourceUri` points at. */
  uri: string;
  name: string;
  description: string;
  /** The self-contained HTML document, with `__CUBBY_ORIGIN__` unsubstituted. */
  html: string;
};

export const SHOPPING_LIST_UI = "ui://cubby/shopping-list.html";
export const USDA_PICKER_UI = "ui://cubby/usda-picker.html";

export const MCP_APP_BUNDLES: McpAppBundle[] = [
  {
    uri: SHOPPING_LIST_UI,
    name: "Shopping List",
    description:
      "Checkable shopping list grouped by availability, with the per-meal breakdown behind each item.",
    html: bundleFor("shopping-list"),
  },
  {
    uri: USDA_PICKER_UI,
    name: "USDA Food Picker",
    description:
      "USDA search results as pickable cards, showing data-type richness and macros per 100g.",
    html: bundleFor("usda-picker"),
  },
];

export { withCubbyOrigin } from "./origin";
