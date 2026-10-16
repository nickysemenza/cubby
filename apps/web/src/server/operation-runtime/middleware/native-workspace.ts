import {
  createMiddleware,
  type RequestMiddlewareAfterServer,
} from "@tanstack/react-start";

import {
  appleClientUpdateError,
  appleClientUpdateRequired,
} from "~/server/http/apple-client-gate";

// Hosted documents and Start commands must obey the same native minimum as
// HTTP calls. WebKit sends its app identity on every request, not just login.
export const nativeWorkspaceClientGate: RequestMiddlewareAfterServer<
  {},
  undefined,
  undefined
> = createMiddleware().server(async ({ request, next }) => {
  const outdated = appleClientUpdateRequired(request.headers);
  if (outdated) {
    return new Response(JSON.stringify(appleClientUpdateError(outdated)), {
      status: 426,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    });
  }
  return next();
});
