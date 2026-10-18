import {
  statementRowDisposition,
  statementRowMatchState,
} from "@cubby/schemas/statement-row";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { listChromePage } from "~/entity/routing/list-page";
import { StatementRowList } from "~/features/statement-import/statement-row-list";
import { StatementSuggestions } from "~/features/statement-import/statement-suggestions";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";
import { useTabParam } from "~/ui/hooks/use-tab-param";
import { Button } from "~/ui/primitives/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

// `"all"` is a client-only sentinel (never reaches the server filter — see
// buildFilters in statement-row-list.tsx): the worklist default is
// `matchState: "unmatched"`, so there must be a distinct URL value meaning
// "no matchState filter" rather than "absent, therefore unmatched".
const tabSchema = z.enum(["rows", "suggestions"]);

const matchStateSearchValue = z.union([
  statementRowMatchState,
  z.literal("all"),
]);
const searchSchema = z.object({
  matchState: matchStateSearchValue.optional().catch(undefined),
  disposition: statementRowDisposition.optional().catch(undefined),
  source: urlStringParam,
  dateFrom: urlStringParam,
  dateTo: urlStringParam,
  q: urlStringParam,
  /** `suggestions` opens the grouped Transaction suggestion review. */
  tab: tabSchema.optional().catch(undefined),
  /** Suggestions view: one account's (FAC-) and one month's (YYYY-MM) group. */
  account: urlStringParam,
  month: urlStringParam,
});

// Stripped back out of the URL when it equals the app's default worklist
// view, so a fresh `/statement-rows` link and an explicit `?matchState=` one
// both round-trip to the same clean URL.
const searchDefaults = {
  matchState: "unmatched",
  disposition: undefined,
  source: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  q: undefined,
  tab: undefined,
  account: undefined,
  month: undefined,
} as const;

function StatementRowsTabs() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const tabs = useTabParam(search.tab, "rows", tabSchema, (next) =>
    navigate({ to: ".", search: (previous) => ({ ...previous, tab: next }) }),
  );
  return (
    <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
      <TabsList
        variant="line"
        className="h-auto max-w-full flex-wrap justify-start gap-2 [&>[data-slot=tabs-trigger]]:flex-none"
      >
        <TabsTrigger value="rows">Rows</TabsTrigger>
        <TabsTrigger value="suggestions">Suggestions</TabsTrigger>
      </TabsList>
      <TabsContent value="rows">
        {tabs.value === "rows" ? <StatementRowList /> : null}
      </TabsContent>
      <TabsContent value="suggestions">
        {tabs.value === "suggestions" ? <StatementSuggestions /> : null}
      </TabsContent>
    </Tabs>
  );
}

// Bound to a const, not inlined into the options object below: see
// `list-page.tsx`'s doc comment on why the splitter needs a literal
// identifier here, not an inline factory call.
const StatementRowsPage = listChromePage({
  title: "Statement Rows",
  layout: "full",
  compact: true,
  page: StatementRowsTabs,
  actions: () => (
    <Button render={<Link to="/statement-rows/import" />} nativeButton={false}>
      Import statement
    </Button>
  ),
});

export const Route = createFileRoute("/_authenticated/statement-rows/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: StatementRowsPage,
  head: () => ({ meta: [{ title: pageTitle("Statement Rows") }] }),
});
