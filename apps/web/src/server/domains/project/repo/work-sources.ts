import { projectFiltersSchema } from "@cubby/schemas/project";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { project as table } from "~/server/db/schema";
import {
  projectAttention,
  projectScaffold,
} from "~/server/domains/project/repo/lookup";
import type { ProjectWorkContext } from "~/server/domains/project/repo/work-context";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const projectWorkSources = (
  context: ProjectWorkContext,
): WorkSource[] => [
  ...entityProblemSources("project", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("project", assembly);
    const attention = assembly.some((filter) => filter.id === "attention")
      ? await context.attentionItems(db, scope)
      : undefined;
    return {
      query: selectWorkCandidates(db, source, {
        entity: "project",
        id: sql`${table.shortcode}`,
        name: labelSql("project", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            await projectScaffold.prepareWhere(
              db,
              projectFiltersSchema.parse(filters),
              attention ? [[projectAttention, attention]] : [],
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
