import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/import/run-agent-file";

export const Route = createFileRoute("/api/import/runs/$publicId/agent/$")({
  server: { handlers },
});
