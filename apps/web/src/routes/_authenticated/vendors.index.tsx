import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import {
  CreateDialogAction,
  createDialogSearchField,
} from "~/app/_components/forms/create-dialog-action";
import { VendorList } from "~/app/vendors/vendorlist";
import { Page } from "~/components/page/Page";
import { vendorCaptureRequest } from "~/entities/editing/editor-requests";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

// The roster's filter params come from the vendor filter manifest — the same
// specs `useTableState` encodes into the URL and decodes back out, so a filtered
// roster is bookmarkable and shareable.
const searchSchema = z.object({
  // Spread FIRST so any manifest spec survives this strict schema: a route with
  // a `z.object` validateSearch strips every key it doesn't declare, which would
  // let the table write a filter to the URL only for the router to remove it
  // again. Deriving the fragment from the manifest means a spec added later
  // can't be silently forgotten here.
  ...entityFilterSearchFields("vendor"),
  // Re-declared by name (a computed Record has no literal key types for
  // `Route.useSearch()` / `<Link search>` to expose) and with `urlStringParam`,
  // NOT a bare `z.string()`: this sits AFTER the spread and overrides it, so a
  // plain string schema would reinstate the hole `urlStringParam` closes —
  // TanStack's `parseSearch` JSON-parses first, so an all-digits vendor search
  // (`?q=486242`) arrives as a number and a `z.string()` would drop it.
  q: urlStringParam,
  ...tableSearchFields,
  ...createDialogSearchField,
});

const searchDefaults = {
  create: undefined,
  q: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/vendors/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: VendorsPage,
  head: () => ({ meta: [{ title: pageTitle("Vendors") }] }),
});

function VendorsPage() {
  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Vendors"
      layout="full"
      actions={
        <CreateDialogAction request={vendorCaptureRequest()}>
          New Vendor
        </CreateDialogAction>
      }
    >
      <VendorList />
    </Page>
  );
}
