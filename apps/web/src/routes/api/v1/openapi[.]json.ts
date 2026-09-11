import { createFileRoute } from "@tanstack/react-router";
import { getCookies } from "better-auth/cookies";

import { auth } from "~/lib/auth";
import document from "~/lib/generated/http-openapi.gen.json";
export const Route = createFileRoute("/api/v1/openapi.json")({
  server: {
    handlers: {
      GET: ({ request }) =>
        Response.json({
          ...document,
          servers: [{ url: new URL(request.url).origin }],
          components: {
            ...document.components,
            securitySchemes: {
              ...document.components.securitySchemes,
              sessionCookie: {
                type: "apiKey",
                in: "cookie",
                name: getCookies(auth.options).sessionToken.name,
              },
            },
          },
        }),
    },
  },
});
