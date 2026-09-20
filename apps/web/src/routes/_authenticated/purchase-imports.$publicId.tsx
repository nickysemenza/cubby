import { createFileRoute } from "@tanstack/react-router";

import { PurchaseImportRunDetailPage } from "~/app/purchases/purchase-import-run-detail";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute(
  "/_authenticated/purchase-imports/$publicId",
)({
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`Import ${params.publicId}`) }],
  }),
  component: PurchaseImportRunRoute,
});

function PurchaseImportRunRoute() {
  const { publicId } = Route.useParams();
  return (
    <Page
      variant="list"
      title="Purchase import"
      bodyGutter="standard"
      decoration="none"
    >
      <PurchaseImportRunDetailPage publicId={publicId} />
    </Page>
  );
}
