import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { createDialogSearchField } from "~/app/_components/forms/create-dialog-action";
import { WishList } from "~/app/wishes/wish-list";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

// The list's filter params come from the wish filter manifest — the same
// specs `useTableState` encodes into the URL and decodes back out, so a
// filtered/sorted wishlist is bookmarkable and shareable (unlike the old
// hand-rolled `useState` search box, which held no URL state at all).
const searchSchema = z.object({
  // Spread FIRST so any manifest spec survives this strict schema: a route
  // with a `z.object` validateSearch strips every key it doesn't declare,
  // which would let the table write a filter to the URL only for the router
  // to remove it again. Deriving the fragment from the manifest means a spec
  // added later can't be silently forgotten here.
  ...entityFilterSearchFields("wish"),
  // Re-declared by name (a computed Record has no literal key types for
  // `Route.useSearch()` / `<Link search>` to expose) and with `urlStringParam`,
  // NOT a bare `z.string()`: this sits AFTER the spread and overrides it, so a
  // plain string schema would reinstate the hole `urlStringParam` closes.
  q: urlStringParam,
  ...tableSearchFields,
  ...createDialogSearchField,
});

const searchDefaults = {
  q: undefined,
  create: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/wishes/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: WishesPage,
  head: () => ({ meta: [{ title: pageTitle("Wishlist") }] }),
});

function WishesPage() {
  return (
    <Page
      variant="list"
      headerInToolbar
      entity="wish"
      title="Wishlist"
      layout="full"
    >
      <WishList />
    </Page>
  );
}
