import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import {
  CreateDialogAction,
  createDialogSearchField,
} from "~/app/_components/forms/create-dialog-action";
import { PurchaseList } from "~/app/purchases/purchaselist";
import { Page } from "~/components/page/Page";
import { purchaseCaptureRequest } from "~/entities/editing/editor-requests";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import { urlShortcodeListParam, urlStringParam } from "~/lib/search-params";

// Spread first so ANY spec in purchase's filter manifest survives this strict
// schema — a new filter can't be silently stripped by being forgotten here. The
// keys are then re-declared by name below, because a computed Record has no
// literal key types for `<Link search>`/`Route.useSearch()` to expose. Each is a
// `urlStringParam`, never a bare `z.string()`: `?q=486242` and `?date=30` parse
// as numbers and would otherwise be silently dropped.
export const purchaseSearchSchema = z.object({
  ...entityFilterSearchFields("purchase"),
  q: urlStringParam,
  label: urlStringParam,
  vendor: urlShortcodeListParam("vendor"),
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
  validateSearch: purchaseSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: PurchasesPage,
  head: () => ({ meta: [{ title: pageTitle("Purchases") }] }),
});

function PurchasesPage() {
  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Purchases"
      layout="full"
      actions={<CreateDialogAction request={purchaseCaptureRequest()} />}
    >
      <PurchaseList />
    </Page>
  );
}
