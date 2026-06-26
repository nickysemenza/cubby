import { type SearchType, searchTypeSchema } from "@cubby/schemas/search";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { SearchPage } from "~/app/_components/search/search-page";
import { Page } from "~/components/page/Page";

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  type: searchTypeSchema.optional().catch(undefined),
});

const searchDefaults = { q: undefined, type: undefined } as const;

export const Route = createFileRoute("/_authenticated/search/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: SearchPageRoute,
  head: () => ({ meta: [{ title: "Search | cubby" }] }),
});

function SearchPageRoute() {
  const search = Route.useSearch();
  return (
    <Page variant="list" title="Search" compact decoration="none">
      <SearchPage
        query={search.q}
        type={(search.type ?? "all") as SearchType}
      />
    </Page>
  );
}
