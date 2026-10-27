import { financialTransactionFiltersSchema } from "@cubby/schemas/financial-transaction";
import { and, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { outer } from "~/server/db/helpers/related";
import { financialTransaction as table } from "~/server/db/schema";
import { buildFinancialTransactionWhere } from "~/server/domains/financial-transaction/repo/financial-transaction";
import {
  financialTransactionWorkOwners,
  financialTransactionWorkFacts,
} from "~/server/domains/financial-transaction/repo/work-facts";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const financialTransactionWorkSources = (): WorkSource[] => [
  ...entityProblemSources(
    "financialTransaction",
    async (db, source, scope, assembly) => {
      const filters = compileProblemFilters("financialTransaction", assembly);
      return {
        query: selectWorkCandidates(db, source, {
          entity: "financialTransaction",
          id: sql`${table.shortcode}`,
          name: sql`coalesce("FinancialTransaction".merchant, "FinancialTransaction"."rawDescription", 'Financial transaction')`,
          owners: financialTransactionWorkOwners(outer(table.id)),
          shared: false,
          reason: source.reasons[0]!.label,
          reasonKeys: [source.id],
          ...financialTransactionWorkFacts(),
        })
          .from(table)
          .where(
            and(
              await buildFinancialTransactionWhere(
                db,
                financialTransactionFiltersSchema.parse(filters),
              ),
              recordScope(scope, sql`${table.shortcode}`),
            ),
          ),
      };
    },
  ),
];
