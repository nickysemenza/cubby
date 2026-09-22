import { createFileRoute } from "@tanstack/react-router";

import { PurchaseImportRunDetailPage } from "~/app/purchases/purchase-import-run-detail";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute(
  "/_authenticated/purchase-imports/$shortcode",
)({
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`Import ${params.shortcode}`) }],
  }),
  component: PurchaseImportRunRoute,
});

function PurchaseImportRunRoute() {
  const { shortcode } = Route.useParams();
  return (
    <Page
      variant="list"
      title="Purchase import"
      bodyGutter="standard"
      decoration="none"
    >
      <PurchaseImportRunDetailPage publicId={shortcode} />
    </Page>
  );
}
