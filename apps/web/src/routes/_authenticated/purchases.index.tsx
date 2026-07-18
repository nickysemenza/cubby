import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { PurchaseActions } from "~/app/purchases/purchase-actions";
import { PurchaseList } from "~/app/purchases/purchaselist";
import { Page } from "~/components/page/Page";

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  ...tableSearchFields,
});

const searchDefaults = { q: undefined } as const;

export const Route = createFileRoute("/_authenticated/purchases/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: PurchasesPage,
  head: () => ({ meta: [{ title: "Purchases | cubby" }] }),
});

function PurchasesPage() {
  const { q } = Route.useSearch();

  return (
    <Page variant="list" title="Purchases" fullWidth>
      <PurchaseList initialSearch={q} actions={<PurchaseActions />} />
    </Page>
  );
}
