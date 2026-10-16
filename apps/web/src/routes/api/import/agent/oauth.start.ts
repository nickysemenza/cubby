import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/import/agent/oauth.start";

export const Route = createFileRoute("/api/import/agent/oauth/start")({
  server: { handlers },
});
