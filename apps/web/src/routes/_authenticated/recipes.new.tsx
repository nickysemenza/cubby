import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";

import NewRecipe from "~/app/_components/recipe/new-recipe";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

// Accepts the iOS/Android Web Share Target payload (see manifest.json
// `share_target`): a shared recipe link lands here. Safari puts the URL in
// `text` for some flows and `url` for others, so we accept both; `scrape=1`
// (from the in-app "Import from URL" entry point) auto-runs the scrape.
const searchSchema = z.object({
  url: urlStringParam,
  text: urlStringParam,
  title: urlStringParam,
  scrape: z.coerce.boolean().optional().catch(undefined),
});

const searchDefaults = {
  url: undefined,
  text: undefined,
  title: undefined,
  scrape: undefined,
} as const;

// Pull the first http(s) URL out of a shared blob of text (Safari often shares
// "Recipe Name https://…" as one `text` field).
function extractUrl(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(/https?:\/\/\S+/);
    if (match) return match[0];
  }
  return undefined;
}

export const Route = createFileRoute("/_authenticated/recipes/new")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  head: () => ({ meta: [{ title: pageTitle("New recipe") }] }),
  component: NewRecipePage,
});

function NewRecipePage() {
  const { url, text, title, scrape } = Route.useSearch();
  const sharedUrl = extractUrl(url, text);

  return (
    <Page variant="list" title="New recipe" compact>
      <NewRecipe
        initialUrl={sharedUrl}
        initialName={title?.trim() || undefined}
        // A shared URL implies "scrape it now"; the in-app entry point passes
        // scrape=1 to open the panel even without a prefilled URL.
        autoScrape={Boolean(sharedUrl) || scrape === true}
      />
    </Page>
  );
}
