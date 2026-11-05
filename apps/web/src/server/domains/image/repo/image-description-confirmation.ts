import { parseEntityId } from "@cubby/schemas/identifiers";
import { imageDescriptionConfirmationOwner } from "@cubby/schemas/image-processing";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { suggestionTable, image } from "~/server/db/schema";
import {
  suggestionRecordId,
  transitionAssessmentState,
  transitionAssessmentStates,
} from "~/server/generic/assessment/repo/assessment-state";
import { recordChange } from "~/server/generic/changes/repo/change";

/** Caller holds content, record-intent, Image and target projection locks in that order. */
export async function writeImageDescriptionConfirmation(
  db: Database,
  state: Pick<
    typeof suggestionTable.$inferSelect,
    "id" | "recordId" | "fingerprint" | "data"
  >,
  description: string,
  owner: z.infer<typeof imageDescriptionConfirmationOwner>,
) {
  const [source] = await getDb(db)
    .select({ hash: image.sha256 })
    .from(image)
    .where(
      and(
        eq(image.id, parseEntityId("image", state.recordId)),
        notDeleted(image),
      ),
    )
    .for("update")
    .limit(1);
  if (!source || state.fingerprint !== source.hash)
    throw new Error("Image evidence changed before confirmation");
  await transitionAssessmentStates(
    db,
    and(
      eq(suggestionTable.family, "image_description"),
      eq(suggestionTable.recordId, suggestionRecordId(state)),
      sql`${suggestionTable.id} <> ${state.id}`,
    ),
    { confirmedValue: null },
  );
  await transitionAssessmentState(db, state.id, {
    confirmedValue: { present: true, value: description },
    status: "applied",
    data: {
      ...z.record(z.string(), z.json()).parse(state.data ?? {}),
      confirmationOwner: imageDescriptionConfirmationOwner.parse(owner),
    },
  });
  await recordChange(db, { kind: "source", categories: ["image"] });
}
