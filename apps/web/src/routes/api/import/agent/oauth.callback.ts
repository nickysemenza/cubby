import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/import/agent/oauth.callback";

export const Route = createFileRoute("/api/import/agent/oauth/callback")({
  server: { handlers },
});
