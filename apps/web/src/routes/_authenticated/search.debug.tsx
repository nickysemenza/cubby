import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import { SearchDebugPage } from "~/features/search/search-debug-page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/search/debug")({
  component: SearchDebugRoute,
  head: () => ({ meta: [{ title: pageTitle("Search debug") }] }),
});

function SearchDebugRoute() {
  return (
    <Page variant="list" title="Search debug" compact>
      <SearchDebugPage />
    </Page>
  );
}
