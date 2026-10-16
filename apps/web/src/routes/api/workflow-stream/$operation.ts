import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/workflow-stream/$operation";

export const Route = createFileRoute("/api/workflow-stream/$operation")({
  server: { handlers },
});
