import { userId } from "@cubby/schemas/identifiers";
import {
  initiateRunEvidenceUploadInput,
  initiateRunEvidenceUploadOut,
  type InitiateRunEvidenceUploadInput,
} from "@cubby/schemas/purchase-import";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import type { Database } from "~/server/db";
import { run as runTable, runEvidence, runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";
import { generatePresignedUploadUrl } from "~/server/utils/s3";

const safeFilename = (value: string) =>
  value.replaceAll(/[^A-Za-z0-9._-]/gu, "_").slice(0, 255);

/**
 * Allocates immutable, target-scoped R2 storage. The metadata is recorded
 * before the PUT so a failed upload remains operational state, never an image
 * orphan and never a Purchase/Product attachment.
 */
export async function initiateRunEvidenceUpload(
  db: Database,
  rawInput: InitiateRunEvidenceUploadInput,
  actorUserId: string,
) {
  const input = initiateRunEvidenceUploadInput.parse(rawInput);
  const database = getDb(db);
  const [target] = await database
    .select({ runId: runTarget.runId })
    .from(runTarget)
    .innerJoin(runTable, eq(runTable.id, runTarget.runId))
    .where(
      and(
        eq(runTarget.id, input.targetId),
        eq(runTable.shortcode, input.runId),
        eq(runTable.actorUserId, userId.parse(actorUserId)),
        inArray(runTable.status, ["running", "dispatch_failed"]),
      ),
    )
    .limit(1);
  if (!target) throw new Error("Import evidence target is not writable");

  const evidenceId = crypto.randomUUID();
  const objectKey = `${env.R2_KEY_PREFIX}/import-runs/${input.runId}/${input.targetId}/${evidenceId}-${safeFilename(input.filename)}`;
  await database.insert(runEvidence).values({
    id: evidenceId,
    runId: target.runId,
    targetId: input.targetId,
    kind: input.kind,
    objectKey,
    checksum: input.checksum,
    mediaType: input.contentType,
    byteSize: input.byteSize,
    sourceMetadata: input.sourceMetadata,
  });
  const expiresIn = 300;
  const uploadUrl = await generatePresignedUploadUrl({
    key: objectKey,
    contentType: input.contentType,
    expiresIn,
  });
  return initiateRunEvidenceUploadOut.parse({
    evidenceId,
    objectKey,
    uploadUrl,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
  });
}

export async function loadRunEvidenceForExtraction(
  db: Database,
  runId: string,
) {
  const [evidence] = await getDb(db)
    .select({
      id: runEvidence.id,
      objectKey: runEvidence.objectKey,
      checksum: runEvidence.checksum,
      mediaType: runEvidence.mediaType,
      targetId: runEvidence.targetId,
      sourceKind: runTarget.sourceKind,
      sourceExternalKey: runTarget.sourceExternalKey,
    })
    .from(runEvidence)
    .innerJoin(runTable, eq(runTable.id, runEvidence.runId))
    .innerJoin(runTarget, eq(runTarget.id, runEvidence.targetId))
    .where(
      and(
        eq(runEvidence.runId, z.uuid().parse(runId)),
        eq(runTable.purpose, "purchase_validation"),
      ),
    )
    .orderBy(desc(runEvidence.createdAt))
    .limit(1);
  return evidence
    ? { ...evidence, evidenceUrl: getR2PublicUrl(evidence.objectKey) }
    : null;
}
