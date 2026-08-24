import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { listPage } from "~/app/_components/routing/entity-routes";
import { WishList } from "~/app/wishes/wish-list";
import { wishSearchDefaults, wishSearchSchema } from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const WishesPage = listPage({
  title: "Wishlist",
  entity: "wish",
  list: WishList,
});

export const Route = createFileRoute("/_authenticated/wishes/")({
  validateSearch: wishSearchSchema,
  search: { middlewares: [stripSearchParams(wishSearchDefaults)] },
  head: () => ({ meta: [{ title: pageTitle("Wishlist") }] }),
  component: WishesPage,
});
