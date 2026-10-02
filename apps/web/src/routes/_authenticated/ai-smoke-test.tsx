import { createFileRoute } from "@tanstack/react-router";

import { AiSmokeTest } from "~/features/developer/ai-smoke-test";
import { pageTitle } from "~/lib/page-title";
import { Page } from "~/ui/page/Page";

export const Route = createFileRoute("/_authenticated/ai-smoke-test")({
  component: AiSmokeTestPage,
  head: () => ({ meta: [{ title: pageTitle("AI smoke test") }] }),
});

function AiSmokeTestPage() {
  return (
    <Page variant="list" title="AI smoke test">
      <AiSmokeTest />
    </Page>
  );
}
