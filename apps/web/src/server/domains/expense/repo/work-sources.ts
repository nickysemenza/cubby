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
import { workAcceptedOrderOwners } from "~/server/domains/purchase/repo/work-owners";
import {
  entityProblemSources,
  gapDeclaration,
  gapPublicationRead,
  recordScope,
  selectWorkGapCandidates,
} from "~/server/generic/work-queue/repo/work-declarations";
import type { WorkSource } from "~/server/generic/work-queue/repo/work-source";

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
    return selectWorkGapCandidates(db, gaps, {
      table,
      readGap,
      where: and(baseWhere, recordScope(scope, sql`${table.shortcode}`)),
      ctes: [workAcceptedOrderOwners],
      columns: {
        entity: "expense",
        id: sql`${table.shortcode}`,
        name: sql`"Expense".name`,
        owners: workExpenseSourceOwners(outer(table.id)),
        shared: false,
        ...expenseWorkFacts(),
      },
    });
  },
};
export const expenseWorkSources = (): WorkSource[] => [
  gapSource,
  ...entityProblemSources("expense", {
    table,
    ctes: [workAcceptedOrderOwners],
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
