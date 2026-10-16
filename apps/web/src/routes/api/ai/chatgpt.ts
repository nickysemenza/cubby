import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/api/ai/chatgpt";

export const Route = createFileRoute("/api/ai/chatgpt")({
  server: { handlers },
});
