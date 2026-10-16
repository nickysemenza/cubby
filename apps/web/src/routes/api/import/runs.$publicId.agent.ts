import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/import/runs.$publicId.agent";

export const Route = createFileRoute("/api/import/runs/$publicId/agent")({
  server: { handlers },
});
