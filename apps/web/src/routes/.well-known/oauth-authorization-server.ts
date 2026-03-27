import { createFileRoute } from "@tanstack/react-router";

// MCP clients probe this endpoint for OAuth discovery.
// Return 404 so they fall back to static Authorization headers.
export const Route = createFileRoute("/.well-known/oauth-authorization-server")(
  {
    server: {
      handlers: {
        GET: () => new Response(null, { status: 404 }),
      },
    },
  },
);
