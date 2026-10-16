import type { HttpRouteHandlers } from "~/lib/http/route-handler";

import { handlePurchaseAgentOAuthCallback } from "./oauth.callback.impl";

export const handlers: HttpRouteHandlers<Record<never, never>, "GET"> = {
  GET: ({ request }) => handlePurchaseAgentOAuthCallback(request),
};
