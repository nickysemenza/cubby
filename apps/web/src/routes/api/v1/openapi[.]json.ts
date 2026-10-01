import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/openapi.json")({
  server: {
    handlers: {
      // Loaded on request: the document is ~1.7 MB and its cookie helper pulls
      // the OAuth provider chunk, both of which otherwise load on every request.
      GET: async ({ request }) => {
        const [{ default: document }, { getCookies }, { auth }] =
          await Promise.all([
            import("~/lib/generated/http-openapi.gen.json"),
            import("better-auth/cookies"),
            import("~/lib/auth"),
          ]);
        return Response.json({
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
        });
      },
    },
  },
});
