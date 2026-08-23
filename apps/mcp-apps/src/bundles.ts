/**
 * `apps/web` consumes this to register `ui://` resources, while `build.mjs`
 * discovers sibling HTML entry points. The built bundle is inlined because a
 * Cloudflare Worker has no filesystem to read at request time.
 */

/**
 * Built bundles, keyed by `/absolute/path/to/dist/<id>.html`.
 *
 * A glob rather than one import line per app, so the list below stays the only
 * thing to edit. It resolves at build time exactly like a static import — but
 * it yields `{}` instead of throwing when `dist/` is missing, so `bundleFor`
 * raises the error itself and keeps the failure loud. (`pnpm dev`, `test`, and
 * `build:cf` all gate on `scripts/ensure-mcp-apps.ts`, so this should only
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
  uri: string;
  name: string;
  description: string;
  html: string;
};

export const SHOPPING_LIST_UI = "ui://cubby/shopping-list.html";
export const USDA_PICKER_UI = "ui://cubby/usda-picker.html";

export const MCP_APP_BUNDLES: McpAppBundle[] = [
  {
    uri: SHOPPING_LIST_UI,
    name: "Shopping List",
    description:
      "Checkable meal-plan shopping list grouped by availability, with price coverage, omissions, and per-meal detail.",
    html: bundleFor("shopping-list"),
  },
  {
    uri: USDA_PICKER_UI,
    name: "USDA Food Picker",
    description:
      "Refinable USDA search results with source explanations, match evidence, existing Cubby links, and macros per 100g.",
    html: bundleFor("usda-picker"),
  },
];

export { withCubbyOrigin } from "./origin";
