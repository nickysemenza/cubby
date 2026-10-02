import { createFileRoute } from "@tanstack/react-router";

import { AiUsagePage } from "~/features/ai/ai-usage-page";
import { pageTitle } from "~/lib/page-title";
import { Page } from "~/ui/page/Page";

export const Route = createFileRoute("/_authenticated/ai-usage")({
  component: AiUsageRoute,
  head: () => ({ meta: [{ title: pageTitle("AI usage") }] }),
});

function AiUsageRoute() {
  return (
    <Page variant="list" title="AI usage" compact decoration="none">
      <AiUsagePage />
    </Page>
  );
}
