import { createFileRoute } from "@tanstack/react-router";
import { SearchDebugPage } from "~/app/_components/search/search-debug-page";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/search/debug")({
  component: SearchDebugRoute,
  head: () => ({ meta: [{ title: pageTitle("Search debug") }] }),
});

function SearchDebugRoute() {
  return (
    <Page variant="list" title="Search debug" compact decoration="none">
      <SearchDebugPage />
    </Page>
  );
}
