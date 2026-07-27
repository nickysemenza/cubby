import { createFileRoute } from "@tanstack/react-router";
import { auth } from "~/lib/auth";
import { withDefaultResource } from "~/server/oauth/default-resource";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        return auth.handler(request);
      },
      POST: async ({ request }: { request: Request }) => {
        return auth.handler(await withDefaultResource(request));
      },
    },
  },
});
