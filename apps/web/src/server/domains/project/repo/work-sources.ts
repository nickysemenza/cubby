import { projectFiltersSchema } from "@cubby/schemas/project";
import { getTableName, sql } from "drizzle-orm";

import { project as table } from "~/server/db/schema";
import {
  projectAttention,
  projectScaffold,
} from "~/server/domains/project/repo/lookup";
import type { ProjectWorkContext } from "~/server/domains/project/repo/work-context";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const projectWorkSources = async (
  context: ProjectWorkContext,
): Promise<WorkSource[]> => [
  ...entityProblemSources("project", {
    table,
    columns: {
      name: await labelSql("project", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: projectScaffold,
    parseFilters: projectFiltersSchema.parse,
    prepare: async (db, scope, assembly) => {
      const attention = assembly.some((filter) => filter.id === "attention")
        ? await context.attentionItems(db, scope)
        : undefined;
      return attention ? [[projectAttention, attention]] : [];
    },
  }),
];
