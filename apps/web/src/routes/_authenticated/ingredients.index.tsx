import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { listPage } from "~/app/_components/routing/entity-routes";
import { IngredientList } from "~/app/ingredients/ingredientlist";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import { ingredientListSearchSchema } from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const IngredientsPage = listPage({
  title: "Ingredients",
  list: IngredientList,
});

export const Route = createFileRoute("/_authenticated/ingredients/")({
  validateSearch: ingredientListSearchSchema,
  search: { middlewares: [stripSearchParams({})] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "ingredient",
      search: deps,
    }),
  head: () => ({ meta: [{ title: pageTitle("Ingredients") }] }),
  component: IngredientsPage,
});
