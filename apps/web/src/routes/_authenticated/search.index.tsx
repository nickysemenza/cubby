import { type SearchType, searchTypeSchema } from "@cubby/schemas/search";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { SearchPage } from "~/app/_components/search/search-page";
import { PageWrapper } from "~/components/layout/page-wrapper";

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
    <PageWrapper>
      <SearchPage
        query={search.q}
        type={(search.type ?? "all") as SearchType}
      />
    </PageWrapper>
  );
}
