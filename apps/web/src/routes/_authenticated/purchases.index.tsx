import { createFileRoute } from "@tanstack/react-router";
import { PurchaseActions } from "~/app/purchases/purchase-actions";
import { PurchaseList } from "~/app/purchases/purchaselist";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/purchases/")({
  component: PurchasesPage,
  head: () => ({ meta: [{ title: "Purchases | cubby" }] }),
});

function PurchasesPage() {
  return (
    <Page variant="list" title="Purchases" fullWidth>
      <PurchaseList actions={<PurchaseActions />} />
    </Page>
  );
}
