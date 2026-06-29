import { createFileRoute } from "@tanstack/react-router";
import { SearchDebugPage } from "~/app/_components/search/search-debug-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/search/debug")({
  component: SearchDebugRoute,
  head: () => ({ meta: [{ title: "Search debug | cubby" }] }),
});

function SearchDebugRoute() {
  return (
    <Page variant="list" title="Search debug" compact decoration="none">
      <SearchDebugPage />
    </Page>
  );
}
