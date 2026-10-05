import { createFileRoute } from "@tanstack/react-router";

import { APP_ORIGIN } from "~/lib/auth-constants";
import openApiDocumentUrl from "~/lib/generated/http-openapi.gen.json?url";
import { getAssetsFetcher } from "~/server/cf-env";

type OpenApiDocument = typeof import("~/lib/generated/http-openapi.gen.json");

/**
 * The ~1.7 MB document ships as a hashed static asset, not a Worker module, so
 * an unchanged document costs no Worker upload bytes on deploy.
 */
let openApiDocumentPromise: Promise<OpenApiDocument> | undefined;

function loadOpenApiDocument(): Promise<OpenApiDocument> {
  if (openApiDocumentPromise) return openApiDocumentPromise;
  // Parse once per isolate; a failed read must not poison the cache.
  const loadPromise = readOpenApiDocument();
  openApiDocumentPromise = loadPromise.catch(() => {
    openApiDocumentPromise = undefined;
    return loadPromise;
  });
  return openApiDocumentPromise;
}

async function readOpenApiDocument(): Promise<OpenApiDocument> {
  const assetsFetch = getAssetsFetcher();
  if (assetsFetch) {
    const response = await assetsFetch(
      new Request(new URL(openApiDocumentUrl, APP_ORIGIN)),
    );
    if (!response.ok) {
      throw new Error(
        `Failed to load OpenAPI document asset (${response.status} ${response.statusText})`,
      );
    }
    return response.json();
  }
  // Vitest has no ASSETS binding; production builds drop this branch so the
  // JSON never re-enters the Worker bundle.
  if (import.meta.env.DEV) {
    return (await import("~/lib/generated/http-openapi.gen.json")).default;
  }
  throw new Error(
    "The ASSETS binding is required to serve the OpenAPI document",
  );
}

export const Route = createFileRoute("/api/v1/openapi.json")({
  server: {
    handlers: {
      // Loaded on request: the cookie helper pulls the OAuth provider chunk,
      // which otherwise loads on every request.
      GET: async ({ request }) => {
        const [document, { getCookies }, { auth }] = await Promise.all([
          loadOpenApiDocument(),
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
