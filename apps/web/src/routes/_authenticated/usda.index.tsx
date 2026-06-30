import { createFileRoute } from "@tanstack/react-router";
import { USDAFoodList } from "~/app/usda/usdafoodlist";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/usda/")({
  component: USDAPage,
});

function USDAPage() {
  return (
    <Page variant="list" title="USDA Foods" fullWidth>
      <USDAFoodList />
    </Page>
  );
}
