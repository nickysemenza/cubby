import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/well-known.oauth-protected-resource";

export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: { handlers },
});
