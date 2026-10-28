import { parseEntityId } from "@cubby/schemas/identifiers";
import { imageDescriptionConfirmationOwner } from "@cubby/schemas/image-processing";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { assessmentState, image } from "~/server/db/schema";
import {
  transitionAssessmentState,
  transitionAssessmentStates,
} from "~/server/generic/assessment/repo/assessment-state";
import { recordChange } from "~/server/generic/changes/repo/change";

/** Caller holds content, record-intent, Image and target projection locks in that order. */
export async function writeImageDescriptionConfirmation(
  db: Database,
  state: Pick<
    typeof assessmentState.$inferSelect,
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
  const cause = {
    kind: "image_description_confirmed",
    feedbackId:
      owner.kind === "member"
        ? owner.commandFeedbackId
        : owner.sourceFeedbackId,
  };
  await transitionAssessmentStates(
    db,
    and(
      eq(assessmentState.family, "image_description"),
      eq(assessmentState.recordId, state.recordId),
      sql`${assessmentState.id} <> ${state.id}`,
    ),
    { confirmedValue: null },
    cause,
  );
  await transitionAssessmentState(
    db,
    state.id,
    {
      confirmedValue: { present: true, value: description },
      status: "applied",
      data: {
        ...z.record(z.string(), z.json()).parse(state.data ?? {}),
        confirmationOwner: imageDescriptionConfirmationOwner.parse(owner),
      },
    },
    cause,
  );
  await recordChange(db, { kind: "source", categories: ["image"] });
}
