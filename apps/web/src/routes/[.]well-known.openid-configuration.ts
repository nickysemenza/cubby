import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/well-known.openid-configuration";

export const Route = createFileRoute("/.well-known/openid-configuration")({
  server: { handlers },
});
