import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/well-known.oauth-authorization-server";

export const Route = createFileRoute("/.well-known/oauth-authorization-server")(
  {
    server: { handlers },
  },
);
