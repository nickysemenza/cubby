import type { HttpRouteHandlers } from "~/lib/http-route-handler";
import {
  preflightHandler,
  protectedResourceHandler,
} from "~/server/http/oauth/metadata";

// RFC 9728. Claude Code checks this bare path before falling back to RFC 8414.

export const handlers: HttpRouteHandlers<
  Record<never, never>,
  "GET" | "OPTIONS"
> = {
  GET: protectedResourceHandler,
  OPTIONS: preflightHandler,
};
