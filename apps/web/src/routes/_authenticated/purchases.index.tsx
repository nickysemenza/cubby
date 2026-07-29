import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { PurchaseActions } from "~/app/purchases/purchase-actions";
import { PurchaseList } from "~/app/purchases/purchaselist";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-manifest";
import { urlStringParam } from "~/lib/search-params";

// Spread first so ANY spec in purchase's filter manifest survives this strict
// schema — a new filter can't be silently stripped by being forgotten here. The
// keys are then re-declared by name below, because a computed Record has no
// literal key types for `<Link search>`/`Route.useSearch()` to expose. Each is a
// `urlStringParam`, never a bare `z.string()`: `?q=486242` and `?date=30` parse
// as numbers and would otherwise be silently dropped.
const searchSchema = z.object({
  ...entityFilterSearchFields("purchase"),
  q: urlStringParam,
  vendor: urlStringParam,
  orderId: urlStringParam,
  date: urlStringParam,
  statedTotal: urlStringParam,
  ...tableSearchFields,
});

const searchDefaults = {
  q: undefined,
  vendor: undefined,
  orderId: undefined,
  date: undefined,
  statedTotal: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/purchases/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: PurchasesPage,
  head: () => ({ meta: [{ title: "Purchases | cubby" }] }),
});

function PurchasesPage() {
  return (
    <Page
      variant="list"
      title="Purchases"
      fullWidth
      actions={<PurchaseActions />}
    >
      <PurchaseList />
    </Page>
  );
}
