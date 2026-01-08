import { createFileRoute } from "@tanstack/react-router";
import { auth } from "~/lib/auth";

export const Route = createFileRoute("/api/auth/$")({
  // @ts-expect-error - TanStack Start server handlers type not yet in @tanstack/react-router
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        return auth.handler(request);
      },
      POST: ({ request }: { request: Request }) => {
        return auth.handler(request);
      },
    },
  },
});
