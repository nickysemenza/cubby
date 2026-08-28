import { createFileRoute } from "@tanstack/react-router";

import {
  authServerMetadataHandler,
  preflightHandler,
} from "~/server/oauth/metadata";

// RFC 8414 discovery. Clients that treat the origin as the issuer probe this
// bare path first (Claude Code's documented chain does), so serve the same
// metadata the issuer-suffixed alias returns.
export const Route = createFileRoute("/.well-known/oauth-authorization-server")(
  {
    server: {
      handlers: {
        GET: authServerMetadataHandler,
        OPTIONS: preflightHandler,
      },
    },
  },
);
