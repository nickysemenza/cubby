import { createFileRoute } from "@tanstack/react-router";
import { AiSmokeTest } from "~/app/_components/dev/ai-smoke-test";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/ai-smoke-test")({
  component: AiSmokeTestPage,
  head: () => ({ meta: [{ title: "AI smoke test | cubby" }] }),
});

function AiSmokeTestPage() {
  return (
    <EntityLayout title="AI smoke test">
      <AiSmokeTest />
    </EntityLayout>
  );
}
