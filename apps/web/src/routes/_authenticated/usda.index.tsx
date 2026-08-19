import { createFileRoute } from "@tanstack/react-router";
import { USDAFoodList } from "~/app/usda/usdafoodlist";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/usda/")({
  head: () => ({ meta: [{ title: pageTitle("USDA") }] }),
  component: USDAPage,
});

function USDAPage() {
  return (
    <Page variant="list" headerInToolbar title="USDA Foods" layout="full">
      <USDAFoodList />
    </Page>
  );
}
