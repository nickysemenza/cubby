import type { HttpRouteHandlers } from "~/lib/http-route-handler";

export const handlers: HttpRouteHandlers<Record<never, never>, "ANY"> = {
  ANY: async ({ request }) => {
    const { handleBrowserOperationDispatch } =
      await import("~/server/operation-runtime/browser-operation-dispatch");
    return handleBrowserOperationDispatch(request);
  },
};
