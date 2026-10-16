import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/v1/$resource/$operation";

export const Route = createFileRoute("/api/v1/$resource/$operation")({
  server: { handlers },
});
