import {
  statementRowDisposition,
  statementRowMatchState,
} from "@cubby/schemas/statement-row";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { StatementRowList } from "~/app/_components/statement-rows/statement-row-list";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

// `"all"` is a client-only sentinel (never reaches the tRPC filter — see
// buildFilters in statement-row-list.tsx): the worklist default is
// `matchState: "unmatched"`, so there must be a distinct URL value meaning
// "no matchState filter" rather than "absent, therefore unmatched".
const matchStateSearchValue = z.union([
  statementRowMatchState,
  z.literal("all"),
]);
export type MatchStateSearchValue = z.infer<typeof matchStateSearchValue>;

const searchSchema = z.object({
  matchState: matchStateSearchValue.optional().catch(undefined),
  disposition: statementRowDisposition.optional().catch(undefined),
  source: urlStringParam,
  dateFrom: urlStringParam,
  dateTo: urlStringParam,
  q: urlStringParam,
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
} as const;

export const Route = createFileRoute("/_authenticated/statement-rows/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: () => (
    <Page
      variant="list"
      headerInToolbar
      title="Statement Rows"
      layout="full"
      compact
      decoration="none"
    >
      <StatementRowList />
    </Page>
  ),
  head: () => ({ meta: [{ title: pageTitle("Statement Rows") }] }),
});
