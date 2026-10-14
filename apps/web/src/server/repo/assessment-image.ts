import { type ImageId } from "@cubby/schemas/identifiers";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { assessmentState } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

export async function readConfirmedDescription(db: Database, imageId: ImageId) {
  const [row] = await getDb(db)
    .select({
      correction: assessmentState.confirmedValue,
      confirmedAt: assessmentState.createdAt,
    })
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.family, "image_description"),
        eq(assessmentState.entity, "image"),
        eq(assessmentState.recordId, imageId),
        eq(assessmentState.active, true),
        sql`${assessmentState.confirmedValue} @> ${JSON.stringify({ present: true })}::jsonb`,
      ),
    )
    .orderBy(desc(assessmentState.createdAt))
    .limit(1);
  return row?.correction?.present
    ? {
        description: z.string().parse(row.correction.value),
        confirmedAt: row.confirmedAt,
      }
    : null;
}
