import { createFileRoute } from "@tanstack/react-router";

import { ImportRunDetailPage } from "~/app/purchases/purchase-import-run-detail";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/runs/$shortcode")({
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`Run ${params.shortcode}`) }],
  }),
  component: ImportRunRoute,
});

function ImportRunRoute() {
  const { shortcode } = Route.useParams();
  return (
    <Page variant="list" title="Run" bodyGutter="standard" decoration="none">
      <ImportRunDetailPage publicId={shortcode} />
    </Page>
  );
}
