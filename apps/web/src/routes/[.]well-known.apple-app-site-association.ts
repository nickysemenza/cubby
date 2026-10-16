import { createFileRoute } from "@tanstack/react-router";

import { handlers } from "~/server/http/routes/well-known.apple-app-site-association";

export const Route = createFileRoute("/.well-known/apple-app-site-association")(
  {
    server: { handlers },
  },
);
