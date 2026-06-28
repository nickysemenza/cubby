import { createFileRoute } from "@tanstack/react-router";
import { AiUsagePage } from "~/app/_components/ai/ai-usage-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/ai-usage")({
  component: AiUsageRoute,
  head: () => ({ meta: [{ title: "AI usage | cubby" }] }),
});

function AiUsageRoute() {
  return (
    <Page variant="list" title="AI usage" compact decoration="none">
      <AiUsagePage />
    </Page>
  );
}
