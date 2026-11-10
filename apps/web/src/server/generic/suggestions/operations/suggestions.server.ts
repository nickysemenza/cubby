import { sql } from "drizzle-orm";

import { suggestionsContract } from "~/contracts/suggestions.contract";
import type { Database } from "~/server/db";
import { unwrapDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  acceptCleanSuggestions,
  listSuggestionPage,
  suggestionCountsByFamily,
} from "~/server/generic/suggestions/repo/suggestion-list";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

import { listAutomaticDecisions } from "../repo/automatic-decisions";

/** SET LOCAL must share the reader's connection; a browser timeout cannot stop origin work. */
const suggestionRead = <T>(
  db: Database,
  read: (scoped: Database) => Promise<T>,
) =>
  withTransactionDatabase(
    db,
    async (scoped) => {
      await unwrapDb(scoped).execute(
        sql`SELECT set_config('statement_timeout', '10000', true)`,
      );
      return read(scoped);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

export const suggestionsHandlers = implementOperationDomain(
  suggestionsContract,
  {
    automaticDecisions: (context, input) =>
      suggestionRead(context.db, (db) => listAutomaticDecisions(db, input)),
    list: (context, input) =>
      suggestionRead(context.db, (db) => listSuggestionPage(db, input)),
    counts: (context, input) =>
      suggestionRead(context.db, (db) => suggestionCountsByFamily(db, input)),
    acceptClean: (context, input) =>
      acceptCleanSuggestions(context.db, context, input),
  },
);
