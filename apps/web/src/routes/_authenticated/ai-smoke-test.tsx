import { createFileRoute } from "@tanstack/react-router";
import { AiSmokeTest } from "~/app/_components/dev/ai-smoke-test";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

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
