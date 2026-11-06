import { locationFiltersSchema } from "@cubby/schemas/location";
import { getTableName, sql } from "drizzle-orm";

import { location as table } from "~/server/db/schema";
import { locationScaffold } from "~/server/domains/location/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const locationWorkSources = (): WorkSource[] => [
  ...entityProblemSources("location", {
    table,
    columns: {
      name: labelSql("location", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: locationScaffold,
    parseFilters: locationFiltersSchema.parse,
  }),
];
