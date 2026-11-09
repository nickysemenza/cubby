import { purchaseAgentConnectionStatus } from "@cubby/schemas/purchase-import-debug";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { SettingsPage } from "~/features/account/settings-page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/settings")({
  validateSearch: z.object({
    purchaseAgent: purchaseAgentConnectionStatus.optional().catch(undefined),
  }),
  component: SettingsRoute,
  head: () => ({ meta: [{ title: pageTitle("Settings") }] }),
});

function SettingsRoute() {
  const purchaseAgent = Route.useSearch({
    select: (search) => search.purchaseAgent,
  });
  return <SettingsPage purchaseAgent={purchaseAgent} />;
}
