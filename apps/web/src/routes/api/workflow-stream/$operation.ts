import { createFileRoute } from "@tanstack/react-router";

/**
 * The single route for every workflow stream. Replaces the 13 hand-written
 * `api/*-stream/*.ts` files, each of which paired a hardcoded operation id with
 * a hardcoded URL that only a runtime 404 could disagree with.
 */
export const Route = createFileRoute("/api/workflow-stream/$operation")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { dispatchWorkflowStream } = await import(
          "~/server/workflow-stream-dispatch.server"
        );
        return await dispatchWorkflowStream(params.operation, request);
      },
    },
  },
});
