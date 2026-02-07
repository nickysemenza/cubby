import { type SearchType, searchTypeSchema } from "@cubby/schemas/search";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SearchPage } from "~/app/_components/search/search-page";

const searchSchema = z.object({
  q: z.string().optional(),
  type: searchTypeSchema.optional(),
});

export const Route = createFileRoute("/search/")({
  validateSearch: searchSchema,
  component: SearchPageRoute,
  head: () => ({ meta: [{ title: "Search | cubby" }] }),
});

function SearchPageRoute() {
  const search = Route.useSearch();
  return (
    <SearchPage query={search.q} type={(search.type ?? "all") as SearchType} />
  );
}
