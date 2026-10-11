import { createMiddleware } from "@tanstack/react-start";

import { appleClientUpdateRequired } from "~/server/apple-client-gate";

// Hosted documents and Start commands must obey the same native minimum as
// HTTP calls. WebKit sends its app identity on every request, not just login.
export const nativeWorkspaceClientGate = createMiddleware().server(
  async ({ request, next }) => {
    const outdated = appleClientUpdateRequired(request.headers);
    if (outdated) {
      return new Response(
        JSON.stringify({
          code: "CLIENT_UPDATE_REQUIRED",
          reason: "CLIENT_UPDATE_REQUIRED",
          message: `Cubby ${outdated.current} requires an update to ${outdated.minimum}.`,
        }),
        {
          status: 426,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store",
          },
        },
      );
    }
    return next();
  },
);
