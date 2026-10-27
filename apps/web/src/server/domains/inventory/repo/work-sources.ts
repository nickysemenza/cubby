import { inventoryFiltersSchema } from "@cubby/schemas/inventory";
import { and, eq, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { inventoryEntry as table, product, location } from "~/server/db/schema";
import { buildInventoryWhere } from "~/server/domains/inventory/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const inventoryWorkSources = (): WorkSource[] => [
  ...entityProblemSources("inventory", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("inventory", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "inventory",
        id: sql`${table.shortcode}`,
        name: labelSql("inventory", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .innerJoin(product, eq(product.id, table.productId))
        .innerJoin(location, eq(location.id, table.locationId))
        .where(
          and(
            await buildInventoryWhere(
              db,
              inventoryFiltersSchema.parse(filters),
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
