import { createFileRoute } from "@tanstack/react-router";
import { openIdConfigHandler, preflightHandler } from "~/server/oauth/metadata";

// OIDC discovery at the origin root. The canonical path-appended location
// (`/api/auth/.well-known/openid-configuration`) is served by the plugin
// through the /api/auth/$ catch-all; this covers clients that assume the root.
export const Route = createFileRoute("/.well-known/openid-configuration")({
  server: {
    handlers: {
      GET: openIdConfigHandler,
      OPTIONS: preflightHandler,
    },
  },
});
