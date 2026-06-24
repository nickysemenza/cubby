import { createFileRoute } from "@tanstack/react-router";
import { AiSmokeTest } from "~/app/_components/dev/ai-smoke-test";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/ai-smoke-test")({
  component: AiSmokeTestPage,
  head: () => ({ meta: [{ title: "AI smoke test | cubby" }] }),
});

function AiSmokeTestPage() {
  return (
    <Page variant="list" title="AI smoke test">
      <AiSmokeTest />
    </Page>
  );
}
