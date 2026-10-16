import type { HttpRouteHandlers } from "~/lib/http/route-handler";
import {
  authServerMetadataHandler,
  preflightHandler,
} from "~/server/http/oauth/metadata";

// RFC 8414's path-insertion form for issuer `<origin>/api/auth`. The plugin
// serves the append form (`/api/auth/.well-known/...`) itself through the
// /api/auth/$ catch-all, but this variant sits outside it and needs a route.

export const handlers: HttpRouteHandlers<
  Record<never, never>,
  "GET" | "OPTIONS"
> = {
  GET: authServerMetadataHandler,
  OPTIONS: preflightHandler,
};
