/**
 * `apps/web` consumes this to register `ui://` resources. The one built
 * universal document is inlined because a Cloudflare Worker has no filesystem
 * to read at request time; each resource injects its manifest app id on read.
 */
import { MCP_APP_MANIFEST } from "./metadata";

/**
 * Built universal document, keyed by `/absolute/path/to/dist/app.html`.
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

export type McpAppBundle = (typeof MCP_APP_MANIFEST)[number] & {
  html: string;
};

export const MCP_APP_BUNDLES: McpAppBundle[] = [
  ...MCP_APP_MANIFEST.map((app) => ({ ...app, html: bundleFor("app") })),
];

export { withCubbyAppConfig } from "./origin";
