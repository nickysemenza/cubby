import type { HttpRouteHandlers } from "~/lib/http/route-handler";
import {
  authServerMetadataHandler,
  preflightHandler,
} from "~/server/http/oauth/metadata";

// RFC 8414 discovery. Clients that treat the origin as the issuer probe this
// bare path first (Claude Code's documented chain does), so serve the same
// metadata the issuer-suffixed alias returns.

export const handlers: HttpRouteHandlers<
  Record<never, never>,
  "GET" | "OPTIONS"
> = {
  GET: authServerMetadataHandler,
  OPTIONS: preflightHandler,
};
