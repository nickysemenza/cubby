import { userId } from "@cubby/schemas/identifiers";
import {
  initiateImportRunEvidenceUploadInput,
  initiateImportRunEvidenceUploadOut,
  type InitiateImportRunEvidenceUploadInput,
} from "@cubby/schemas/purchase-import";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import type { Database } from "~/server/db";
import {
  importRun,
  importRunEvidence,
  importRunTarget,
} from "~/server/db/schema";
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
export async function initiateImportRunEvidenceUpload(
  db: Database,
  rawInput: InitiateImportRunEvidenceUploadInput,
  actorUserId: string,
) {
  const input = initiateImportRunEvidenceUploadInput.parse(rawInput);
  const database = getDb(db);
  const [target] = await database
    .select({ runId: importRunTarget.runId })
    .from(importRunTarget)
    .innerJoin(importRun, eq(importRun.id, importRunTarget.runId))
    .where(
      and(
        eq(importRunTarget.id, input.targetId),
        eq(importRun.shortcode, input.runId),
        eq(importRun.actorUserId, userId.parse(actorUserId)),
        inArray(importRun.status, ["running", "dispatch_failed"]),
      ),
    )
    .limit(1);
  if (!target) throw new Error("Import evidence target is not writable");

  const evidenceId = crypto.randomUUID();
  const objectKey = `${env.R2_KEY_PREFIX}/import-runs/${input.runId}/${input.targetId}/${evidenceId}-${safeFilename(input.filename)}`;
  await database.insert(importRunEvidence).values({
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
  return initiateImportRunEvidenceUploadOut.parse({
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
      id: importRunEvidence.id,
      objectKey: importRunEvidence.objectKey,
      checksum: importRunEvidence.checksum,
      mediaType: importRunEvidence.mediaType,
      targetId: importRunEvidence.targetId,
      sourceKind: importRunTarget.sourceKind,
      sourceExternalKey: importRunTarget.sourceExternalKey,
    })
    .from(importRunEvidence)
    .innerJoin(importRun, eq(importRun.id, importRunEvidence.runId))
    .innerJoin(
      importRunTarget,
      eq(importRunTarget.id, importRunEvidence.targetId),
    )
    .where(
      and(
        eq(importRunEvidence.runId, z.uuid().parse(runId)),
        eq(importRun.purpose, "purchase_validation"),
      ),
    )
    .orderBy(desc(importRunEvidence.createdAt))
    .limit(1);
  return evidence
    ? { ...evidence, evidenceUrl: getR2PublicUrl(evidence.objectKey) }
    : null;
}
