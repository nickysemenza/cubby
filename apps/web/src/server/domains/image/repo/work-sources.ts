import { imageListFiltersSchema } from "@cubby/schemas/image";
import { getTableName, sql } from "drizzle-orm";

import { outer } from "~/server/db/helpers/related";
import { image as table } from "~/server/db/schema";
import { imageScaffold } from "~/server/domains/image/repo/image";
import {
  workImageOwners,
  workImageIsShared,
} from "~/server/domains/image/repo/work-owners";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const imageWorkSources = async (): Promise<WorkSource[]> => [
  ...entityProblemSources("image", {
    table,
    columns: {
      name: await labelSql("image", `"${getTableName(table)}"`),
      owners: workImageOwners(outer(table.id)),
      shared: workImageIsShared(sql`${table.id}`),
    },
    scaffold: imageScaffold,
    parseFilters: imageListFiltersSchema.parse,
  }),
];
