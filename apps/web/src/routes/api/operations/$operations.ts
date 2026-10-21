import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/operations";

export const Route = createFileRoute("/api/operations/$operations")({
  server: { handlers },
});
