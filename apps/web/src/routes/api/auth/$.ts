import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/auth/$";

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers },
});
