import { createFileRoute } from "@tanstack/react-router";

import {
  preflightHandler,
  protectedResourceHandler,
} from "~/server/oauth/metadata";

// RFC 9728, resource-path form. This is the URL /api/mcp names in its 401
// `WWW-Authenticate: Bearer resource_metadata="..."` header, so it's the entry
// point for every client that discovers us the spec-compliant way.
export const Route = createFileRoute(
  "/.well-known/oauth-protected-resource/api/mcp",
)({
  server: {
    handlers: {
      GET: protectedResourceHandler,
      OPTIONS: preflightHandler,
    },
  },
});
