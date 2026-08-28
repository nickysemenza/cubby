import { createFileRoute } from "@tanstack/react-router";

import { AiUsagePage } from "~/app/_components/ai/ai-usage-page";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

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
