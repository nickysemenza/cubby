import {
  statementRowDisposition,
  statementRowMatchState,
} from "@cubby/schemas/statement-row";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { z } from "zod";

import { listChromePage } from "~/entity/routing/list-page";
import { StatementRowList } from "~/features/statement-import/statement-row-list";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";
import { Button } from "~/ui/primitives/button";

// Source browsing starts with every observation; reconciliation lives in Suggestions.
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
});

const searchDefaults = {
  matchState: "all",
  disposition: undefined,
  source: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  q: undefined,
} as const;

// Bound to a const, not inlined into the options object below: see
// `list-page.tsx`'s doc comment on why the splitter needs a literal
// identifier here, not an inline factory call.
const StatementRowsPage = listChromePage({
  title: "Statement Rows",
  layout: "full",
  page: StatementRowList,
  actions: () => (
    <>
      <Button
        variant="outline"
        render={
          <Link
            to="/suggestions"
            search={{ family: "statement_transaction" }}
          />
        }
        nativeButton={false}
      >
        Review suggestions
      </Button>
      <Button
        render={<Link to="/statement-rows/import" />}
        nativeButton={false}
      >
        Import statement
      </Button>
    </>
  ),
});

export const Route = createFileRoute("/_authenticated/statement-rows/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: StatementRowsPage,
  head: () => ({ meta: [{ title: pageTitle("Statement Rows") }] }),
});
