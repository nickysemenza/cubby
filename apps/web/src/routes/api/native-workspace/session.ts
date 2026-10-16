import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/native-workspace/session";

export const Route = createFileRoute("/api/native-workspace/session")({
  server: { handlers },
});
