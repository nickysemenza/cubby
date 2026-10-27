import { projectFiltersSchema } from "@cubby/schemas/project";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { project as table } from "~/server/db/schema";
import { buildProjectWhere } from "~/server/domains/project/repo/lookup";
import type { ProjectWorkContext } from "~/server/domains/project/repo/work-context";
import { labelSql } from "~/server/generic/entity-graph/repo/entity-graph";
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
            await buildProjectWhere(
              db,
              projectFiltersSchema.parse(filters),
              assembly.some((filter) => filter.id === "attention")
                ? await context.attentionItems(db, scope)
                : undefined,
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
