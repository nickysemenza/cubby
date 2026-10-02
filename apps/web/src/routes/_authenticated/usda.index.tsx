import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { USDAFoodList } from "~/app/usda/usdafoodlist";
import { entitySearch } from "~/entity/generated/entity-search.gen";
import { listChromePage } from "~/entity/routing/entity-routes";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const USDAPage = listChromePage({
  title: "USDA Foods",
  entity: "usda-food",
  page: USDAFoodList,
});

export const Route = createFileRoute("/_authenticated/usda/")({
  validateSearch: entitySearch["usda-food"].schema,
  search: {
    middlewares: [stripSearchParams(entitySearch["usda-food"].defaults)],
  },
  head: () => ({ meta: [{ title: pageTitle("USDA") }] }),
  component: USDAPage,
});
