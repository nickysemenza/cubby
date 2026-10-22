import { getAuth } from "~/lib/auth";
import type { HttpRouteHandlers } from "~/lib/http/route-handler";
import { withDefaultResource } from "~/server/http/oauth/default-resource";

export const handlers: HttpRouteHandlers<{ _splat: string }, "GET" | "POST"> = {
  GET: ({ request }: { request: Request }) => {
    return getAuth().handler(request);
  },
  POST: async ({ request }: { request: Request }) => {
    return getAuth().handler(await withDefaultResource(request));
  },
};
