import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/mcp";

export const Route = createFileRoute("/api/mcp")({
  server: { handlers },
});
