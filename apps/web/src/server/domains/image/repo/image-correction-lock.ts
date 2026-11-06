import { suggestionSubjects } from "@cubby/schemas/suggestion";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import { image } from "~/server/db/schema";

type ImageDescriptionSubject = Pick<
  z.infer<typeof suggestionSubjects.image_description>,
  "recordId" | "contentHash"
>;

async function lockImageCorrectionIntent(
  db: Database,
  subject: ImageDescriptionSubject,
) {
  // Member confirmation and inference can target the same Image; its row owns intent.
  await getDb(db)
    .select({ id: image.id })
    .from(image)
    .where(eq(image.id, subject.recordId))
    .for("update");
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
