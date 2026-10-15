import { type ImageId } from "@cubby/schemas/identifiers";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentState, feedback } from "~/server/db/schema";

export async function readConfirmedDescription(db: Database, imageId: ImageId) {
  const [row] = await getDb(db)
    .select({
      correction: assessmentState.confirmedValue,
      confirmedAt:
        sql<Date>`coalesce((SELECT max(f."createdAt") FROM ${feedback} f WHERE f."assessmentId"=${assessmentState.id} AND f.metadata @> ${JSON.stringify({ kind: "assessment_application" })}::jsonb AND f.receipt @> ${JSON.stringify({ applied: true })}::jsonb),(${assessmentState.data}->>'confirmedAt')::timestamp,${assessmentState.updatedAt})`.mapWith(
          assessmentState.updatedAt,
        ),
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
    .orderBy(desc(assessmentState.updatedAt))
    .limit(1);
  return row?.correction?.present
    ? {
        description: z.string().parse(row.correction.value),
        confirmedAt: row.confirmedAt,
      }
    : null;
}
