import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import {
  CreateDialogAction,
  createDialogSearchField,
} from "~/app/_components/forms/create-dialog-action";
import { CreatePurchaseDialog } from "~/app/purchases/create-purchase-dialog";
import { PurchaseList } from "~/app/purchases/purchaselist";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
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
  label: urlStringParam,
  vendor: urlStringParam,
  orderId: urlStringParam,
  date: urlStringParam,
  statedTotal: urlStringParam,
  lines: urlStringParam,
  lineTotal: urlStringParam,
  reconciliation: urlStringParam,
  documents: urlStringParam,
  transactions: urlStringParam,
  dataQuality: urlStringParam,
  dataGaps: urlStringParam,
  lineTotalMin: urlStringParam,
  lineTotalMax: urlStringParam,
  ...tableSearchFields,
  ...createDialogSearchField,
});

const searchDefaults = {
  create: undefined,
  q: undefined,
  label: undefined,
  vendor: undefined,
  orderId: undefined,
  date: undefined,
  statedTotal: undefined,
  lines: undefined,
  lineTotal: undefined,
  reconciliation: undefined,
  documents: undefined,
  transactions: undefined,
  dataQuality: undefined,
  dataGaps: undefined,
  lineTotalMin: undefined,
  lineTotalMax: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/purchases/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: PurchasesPage,
  head: () => ({ meta: [{ title: pageTitle("Purchases") }] }),
});

function PurchasesPage() {
  return (
    <Page
      variant="list"
      headerInToolbar
      title="Purchases"
      fullWidth
      actions={<CreateDialogAction Dialog={CreatePurchaseDialog} />}
    >
      <PurchaseList />
    </Page>
  );
}
