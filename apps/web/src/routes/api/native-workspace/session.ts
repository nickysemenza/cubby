import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/native-workspace/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { nativeWorkspaceSession } =
          await import("~/server/http/native-workspace-session");
        return nativeWorkspaceSession(request);
      },
    },
  },
});
