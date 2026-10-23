import {
  createMiddleware,
  type RequestMiddlewareAfterServer,
} from "@tanstack/react-start";

import { isBrowserOperationPath } from "~/lib/browser-operation-path";
import {
  appleClientUpdateError,
  appleClientUpdateRequired,
} from "~/server/http/apple-client-gate";

// Hosted documents and Start commands must obey the same native minimum as
// HTTP calls. WebKit sends its app identity on every request, not just login.
// Browser operations are gated per operation by the runner (reads keep
// running); in production the Worker routes them before Start, and this skip
// keeps the dev server's Start route on the same rule.
export const nativeWorkspaceClientGate: RequestMiddlewareAfterServer<
  {},
  undefined,
  undefined
> = createMiddleware().server(async ({ request, next }) => {
  const outdated = isBrowserOperationPath(new URL(request.url).pathname)
    ? null
    : appleClientUpdateRequired(request.headers);
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
