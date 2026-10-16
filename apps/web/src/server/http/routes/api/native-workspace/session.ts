import type { HttpRouteHandlers } from "~/lib/http/route-handler";

export const handlers: HttpRouteHandlers<Record<never, never>, "POST"> = {
  POST: async ({ request }) => {
    const { nativeWorkspaceSession } =
      await import("~/server/http/native-workspace-session");
    return nativeWorkspaceSession(request);
  },
};
