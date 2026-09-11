import { createFileRoute } from "@tanstack/react-router";

import document from "~/lib/generated/http-openapi.gen.json";
export const Route = createFileRoute("/api/v1/openapi.json")({
  server: {
    handlers: {
      GET: ({ request }) =>
        Response.json({
          ...document,
          servers: [{ url: new URL(request.url).origin }],
        }),
    },
  },
});
