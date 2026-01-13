import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsPage } from "~/app/settings/integrations/integrations-page";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsPage,
  server: {
    middleware: [authMiddleware],
  },
});
