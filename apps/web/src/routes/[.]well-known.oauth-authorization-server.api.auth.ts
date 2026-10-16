import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/well-known.oauth-authorization-server.api.auth";

export const Route = createFileRoute(
  "/.well-known/oauth-authorization-server/api/auth",
)({
  server: { handlers },
});
