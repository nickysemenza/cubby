import { createFileRoute } from "@tanstack/react-router";

import { ImportRunDetailPage } from "~/app/purchases/purchase-import-run-detail";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/import-runs/$shortcode")({
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`Import ${params.shortcode}`) }],
  }),
  component: ImportRunRoute,
});

function ImportRunRoute() {
  const { shortcode } = Route.useParams();
  return (
    <Page
      variant="list"
      title="Purchase import"
      bodyGutter="standard"
      decoration="none"
    >
      <ImportRunDetailPage publicId={shortcode} />
    </Page>
  );
}
