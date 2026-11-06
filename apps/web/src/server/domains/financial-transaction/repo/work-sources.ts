import { financialTransactionFiltersSchema } from "@cubby/schemas/financial-transaction";
import { sql } from "drizzle-orm";

import { outer } from "~/server/db/helpers/related";
import { financialTransaction as table } from "~/server/db/schema";
import { financialTransactionScaffold } from "~/server/domains/financial-transaction/repo/financial-transaction";
import {
  financialTransactionWorkOwners,
  financialTransactionWorkFacts,
} from "~/server/domains/financial-transaction/repo/work-facts";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const financialTransactionWorkSources = (): WorkSource[] => [
  ...entityProblemSources("financialTransaction", {
    table,
    columns: {
      name: sql`coalesce("FinancialTransaction".merchant, "FinancialTransaction"."rawDescription", 'Financial transaction')`,
      owners: financialTransactionWorkOwners(outer(table.id)),
      shared: false,
      ...financialTransactionWorkFacts(),
    },
    scaffold: financialTransactionScaffold,
    parseFilters: financialTransactionFiltersSchema.parse,
  }),
];
