import { imageListFiltersSchema } from "@cubby/schemas/image";
import { and, getTableName, sql } from "drizzle-orm";

import { outer } from "~/server/db/helpers/related";
import { image as table } from "~/server/db/schema";
import { imageScaffold } from "~/server/domains/image/repo/image";
import {
  workImageOwners,
  workImageIsShared,
} from "~/server/domains/image/repo/work-owners";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { compileProblemFilters } from "~/server/generic/problems/repo/problem-filter-semantics";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const imageWorkSources = (): WorkSource[] => [
  ...entityProblemSources("image", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("image", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "image",
        id: sql`${table.shortcode}`,
        name: labelSql("image", `"${getTableName(table)}"`),
        owners: workImageOwners(outer(table.id)),
        shared: workImageIsShared(sql`${table.id}`),
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            await imageScaffold.prepareWhere(
              db,
              imageListFiltersSchema.parse(filters),
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
