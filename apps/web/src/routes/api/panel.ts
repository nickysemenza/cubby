import { createFileRoute } from "@tanstack/react-router";
import { appRouter } from "~/server/api/root";

export const Route = createFileRoute("/api/panel")({
  // @ts-expect-error - TanStack Start server handlers type not yet in @tanstack/react-router
  server: {
    handlers: {
      GET: async () => {
        if (process.env.NODE_ENV !== "development") {
          return new Response("Not Found", { status: 404 });
        }

        const { renderTrpcPanel } = await import("trpc-ui");

        return new Response(
          renderTrpcPanel(appRouter, {
            url: "/api/trpc",
            transformer: "superjson",
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          },
        );
      },
    },
  },
});
