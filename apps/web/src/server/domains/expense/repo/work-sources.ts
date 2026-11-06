import { expenseFiltersSchema } from "@cubby/schemas/project";
import { and, sql } from "drizzle-orm";

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
  gapPublicationRead,
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
    const readGap = gapPublicationRead({ scope, entity: "expense" });
    if (!readGap) return null;
    const baseWhere = await expenseScaffold.prepareWhere(
      db,
      expenseFiltersSchema.parse(readGap.filters),
    );
    const candidates = (missingInputs: boolean) =>
      selectWorkCandidates(db, gaps, {
        entity: "expense",
        id: sql`${table.shortcode}`,
        name: sql`"Expense".name`,
        owners: workExpenseSourceOwners(outer(table.id)),
        shared: false,
        ...readGap.columns,
        ...(missingInputs ? readGap.missingColumns : {}),
        ...expenseWorkFacts(),
      })
        .from(table)
        .leftJoin(readGap.publication, readGap.match)
        .where(
          and(
            baseWhere,
            missingInputs ? readGap.missingInputs : readGap.admission,
            recordScope(scope, sql`${table.shortcode}`),
          ),
        );
    return { query: candidates(false), missingInputs: candidates(true) };
  },
};
export const expenseWorkSources = (): WorkSource[] => [
  gapSource,
  ...entityProblemSources("expense", {
    table,
    columns: {
      name: sql`"Expense".name`,
      owners: workExpenseOwners(outer(table.id)),
      ...expenseWorkFacts(),
      shared: false,
    },
    scaffold: expenseScaffold,
    parseFilters: expenseFiltersSchema.parse,
  }),
];
