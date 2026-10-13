import { projectShortcode } from "@cubby/schemas/identifiers";
import { expenseFiltersSchema } from "@cubby/schemas/project";

import { prepareExpenseDerivedRead } from "~/server/repo/expense-derived-read";
import {
  expenseAnalytics,
  expenseSpendSummary,
} from "~/server/repo/expense/analytics";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";

import { reportDependency } from "./dependency";
import type { ProjectReportContext } from "./project";
import { projectId } from "./record-dependencies";

const projectTree = reportDependency(({ request: { db } }) =>
  loadProjectTree(db),
);
export const projectContext = reportDependency(
  async (execution): Promise<ProjectReportContext> => {
    const [id, tree] = await Promise.all([
      execution.read(projectId),
      execution.read(projectTree),
    ]);
    return {
      id,
      code: projectShortcode.parse(execution.request.id),
      tree,
      projectIds: [id, ...collectDescendantIds(tree.childrenByParent, id)],
    };
  },
);

const projectExpenseRead = reportDependency(async (execution) => {
  const { code, projectIds } = await execution.read(projectContext);
  const filters = expenseFiltersSchema.parse({
    projectId: code,
    includeSubProjects: true,
  });
  return {
    filters,
    read: await prepareExpenseDerivedRead(execution.request.db, filters, {
      scope: { projectIds },
    }),
  };
});

export const projectAnalytics = reportDependency(async (execution) => {
  const { filters, read } = await execution.read(projectExpenseRead);
  return expenseAnalytics(execution.request.db, filters, read);
});
export const projectSpend = reportDependency(async (execution) => {
  if (execution.request.slots.includes("project.analytics"))
    return (await execution.read(projectAnalytics)).summary;
  const { filters, read } = await execution.read(projectExpenseRead);
  return expenseSpendSummary(execution.request.db, filters, read);
});
