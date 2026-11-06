import { inventoryFiltersSchema } from "@cubby/schemas/inventory";
import { getTableName, sql } from "drizzle-orm";

import { inventoryEntry as table } from "~/server/db/schema";
import { inventoryScaffold } from "~/server/domains/inventory/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const inventoryWorkSources = async (): Promise<WorkSource[]> => [
  ...entityProblemSources("inventory", {
    table,
    columns: {
      name: await labelSql("inventory", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: inventoryScaffold,
    parseFilters: inventoryFiltersSchema.parse,
  }),
];
