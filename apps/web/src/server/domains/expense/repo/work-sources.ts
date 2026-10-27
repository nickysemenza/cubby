import { expenseFiltersSchema } from "@cubby/schemas/project";
import { and, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { outer } from "~/server/db/helpers/related";
import { expense as table } from "~/server/db/schema";
import { expenseScaffold } from "~/server/domains/expense/repo/lookup";
import { expenseWorkFacts } from "~/server/domains/expense/repo/work-facts";
import {
  workExpenseOwners,
  workExpenseSourceOwners,
} from "~/server/domains/expense/repo/work-owners";
import {
  entityProblemSources,
  gapDeclaration,
  gapFilters,
  gapColumns,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

const gaps = gapDeclaration("expense");
const gapSource: WorkSource = {
  ...gaps,
  candidates: async (db, scope) => {
    const filters = gapFilters(scope, "expense");
    if (!filters) return null;
    return {
      query: selectWorkCandidates(db, gaps, {
        entity: "expense",
        id: sql`${table.shortcode}`,
        name: sql`"Expense".name`,
        owners: workExpenseSourceOwners(outer(table.id)),
        shared: false,
        ...gapColumns(scope, "expense"),
        ...expenseWorkFacts(),
      })
        .from(table)
        .where(
          and(
            await expenseScaffold.prepareWhere(
              db,
              expenseFiltersSchema.parse(filters),
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  },
};
export const expenseWorkSources = (): WorkSource[] => [
  gapSource,
  ...entityProblemSources("expense", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("expense", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "expense",
        id: sql`${table.shortcode}`,
        name: sql`"Expense".name`,
        owners: workExpenseOwners(outer(table.id)),
        shared: false,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
        ...expenseWorkFacts(),
      })
        .from(table)
        .where(
          and(
            await expenseScaffold.prepareWhere(
              db,
              expenseFiltersSchema.parse(filters),
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
