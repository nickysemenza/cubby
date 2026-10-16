import type { HttpRouteHandlers } from "~/lib/http/route-handler";
/**
 * The single route for every workflow stream. Replaces the 13 hand-written
 * `api/*-stream/*.ts` files, each of which paired a hardcoded operation id with
 * a hardcoded URL that only a runtime 404 could disagree with.
 */

export const handlers: HttpRouteHandlers<{ operation: string }, "POST"> = {
  POST: async ({ request, params }) => {
    const { dispatchWorkflowStream } =
      await import("~/server/operation-runtime/workflow-stream-dispatch.server");
    return await dispatchWorkflowStream(params.operation, request);
  },
};
