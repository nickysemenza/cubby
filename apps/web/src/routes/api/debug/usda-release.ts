import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/debug/usda-release";

export const Route = createFileRoute("/api/debug/usda-release")({
  server: { handlers },
});
