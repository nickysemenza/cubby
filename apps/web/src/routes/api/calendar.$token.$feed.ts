import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/calendar.$token.$feed";

export const Route = createFileRoute("/api/calendar/$token/$feed")({
  server: { handlers },
});
