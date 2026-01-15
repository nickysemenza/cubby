import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsPage } from "~/app/settings/integrations/integrations-page";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsPage,
});
