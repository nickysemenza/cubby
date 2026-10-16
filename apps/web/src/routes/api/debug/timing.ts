import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/debug/timing";

export const Route = createFileRoute("/api/debug/timing")({
  server: { handlers },
});
