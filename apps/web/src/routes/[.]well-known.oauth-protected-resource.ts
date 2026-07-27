import { createFileRoute } from "@tanstack/react-router";
import {
  preflightHandler,
  protectedResourceHandler,
} from "~/server/oauth/metadata";

// RFC 9728. Claude Code checks this bare path before falling back to RFC 8414.
export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: {
    handlers: {
      GET: protectedResourceHandler,
      OPTIONS: preflightHandler,
    },
  },
});
