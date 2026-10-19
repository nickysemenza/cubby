import type { HttpRouteHandlers } from "~/lib/http/route-handler";
/**
 * The single route for every workflow stream: the operation id is the URL
 * segment, so no per-stream route can pair an id with a disagreeing URL.
 */

export const handlers: HttpRouteHandlers<{ operation: string }, "POST"> = {
  POST: async ({ request, params }) => {
    const { dispatchWorkflowStream } =
      await import("~/server/operation-runtime/workflow-stream-dispatch.server");
    return await dispatchWorkflowStream(params.operation, request);
  },
};
