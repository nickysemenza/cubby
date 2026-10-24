import { assessmentSubjects } from "@cubby/schemas/assessment";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import { image } from "~/server/db/schema";
import { lockCorrectionKey } from "~/server/generic/assessment/repo/correction-lock";

/** Shared content fence precedes every Image and AssessmentState lock. */
export async function lockImageCorrectionContent(
  db: Database,
  contentHash: string,
) {
  await lockCorrectionKey(db, `image-description:${contentHash}`);
}

type ImageDescriptionSubject = Pick<
  z.infer<typeof assessmentSubjects.image_description>,
  "recordId" | "contentHash"
>;

/** Record intent also protects later content from review of an older publication. */
export async function lockImageCorrectionRecord(
  db: Database,
  recordId: ImageDescriptionSubject["recordId"],
) {
  await lockCorrectionKey(db, `image-description-record:${recordId}`);
}

async function lockImageCorrectionIntent(
  db: Database,
  subject: ImageDescriptionSubject,
) {
  if (subject.contentHash !== null)
    await lockImageCorrectionContent(db, subject.contentHash);
  await lockImageCorrectionRecord(db, subject.recordId);
}

/** History/failed-apply intent remains durable independently of a later domain effect. */
export async function withImageCorrectionIntent<Result>(
  db: Database,
  subject: ImageDescriptionSubject,
  action: (transactionDb: Database) => Promise<Result>,
) {
  return withSnapshotWriteDatabase(
    db,
    async (tx) => {
      await lockImageCorrectionIntent(tx, subject);
      return action(tx);
    },
    { isolationLevel: "serializable" },
  );
}

export async function lockImageDescriptionSubject(
  db: Database,
  input: ImageDescriptionSubject,
) {
  await lockImageCorrectionIntent(db, input);
  const [source] = await getDb(db)
    .select({ hash: image.sha256 })
    .from(image)
    .where(and(eq(image.id, input.recordId), notDeleted(image)))
    .for("update")
    .limit(1);
  if (!source || source.hash !== input.contentHash)
    throw new Error("Image evidence changed before confirmation");
}
