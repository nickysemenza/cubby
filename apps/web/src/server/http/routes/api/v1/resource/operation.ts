import type { HttpRouteHandlers } from "~/lib/http/route-handler";

export const handlers: HttpRouteHandlers<
  { resource: string; operation: string },
  "ANY"
> = {
  ANY: async ({ request }) => {
    const { handleHttpOperation } = await import("~/server/http/http-api");
    return handleHttpOperation(request);
  },
};
