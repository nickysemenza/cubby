import type { HttpRouteHandlers } from "~/lib/http-route-handler";
import {
  openIdConfigHandler,
  preflightHandler,
} from "~/server/http/oauth/metadata";

// OIDC discovery at the origin root. The canonical path-appended location
// (`/api/auth/.well-known/openid-configuration`) is served by the plugin
// through the /api/auth/$ catch-all; this covers clients that assume the root.

export const handlers: HttpRouteHandlers<
  Record<never, never>,
  "GET" | "OPTIONS"
> = {
  GET: openIdConfigHandler,
  OPTIONS: preflightHandler,
};
