import { createFileRoute } from "@tanstack/react-router";

import {
  authServerMetadataHandler,
  preflightHandler,
} from "~/server/oauth/metadata";

// RFC 8414's path-insertion form for issuer `<origin>/api/auth`. The plugin
// serves the append form (`/api/auth/.well-known/...`) itself through the
// /api/auth/$ catch-all, but this variant sits outside it and needs a route.
export const Route = createFileRoute(
  "/.well-known/oauth-authorization-server/api/auth",
)({
  server: {
    handlers: {
      GET: authServerMetadataHandler,
      OPTIONS: preflightHandler,
    },
  },
});
