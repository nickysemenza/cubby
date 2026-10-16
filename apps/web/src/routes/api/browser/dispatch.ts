import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/browser/dispatch";

export const Route = createFileRoute("/api/browser/dispatch")({
  server: { handlers },
});
