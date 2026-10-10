import { runEntityId, userId } from "@cubby/schemas/identifiers";
import {
  initiateRunEvidenceUploadInput,
  initiateRunEvidenceUploadOut,
  type InitiateRunEvidenceUploadInput,
} from "@cubby/schemas/purchase-import";
import { purchaseValidationResearchRunInput } from "@cubby/schemas/run-fields";
import { readResponseWithLimit } from "@cubby/shared/external-fetch";
import { sha256Hex } from "@cubby/shared/sha256";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { APP_ORIGIN } from "~/lib/auth-constants";
import { getExecutionCtx } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  ledgerParty,
  run as runTable,
  runEvidence,
  runTarget,
} from "~/server/db/schema";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { getS3Object } from "~/server/utils/s3";

import {
  productionBrowserEvidenceStorage,
  type BrowserEvidenceStorage,
} from "./browser-results";

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
  return withTransaction(db, async (database) => {
    const [target] = await database
      .select({
        runId: runTarget.runId,
        purpose: runTable.purpose,
        input: runTable.input,
        entityId: runTarget.entityId,
        entityKind: runTarget.entityKind,
      })
      .from(runTarget)
      .innerJoin(runTable, eq(runTable.id, runTarget.runId))
      .where(
        and(
          eq(runTarget.id, input.targetId),
          eq(runTable.shortcode, input.runId),
          eq(runTable.actorUserId, userId.parse(actorUserId)),
          isNull(runTable.retiredAt),
          notDeleted(runTable),
          inArray(runTable.status, ["running", "dispatch_failed"]),
        ),
      )
      .limit(1)
      .for("update", { of: runTable });
    if (!target) throw new Error("Import evidence target is not writable");

    if (target.purpose === "purchase_validation") {
      const admitted = purchaseValidationResearchRunInput.parse(target.input);
      if (
        target.entityKind !== "purchase" ||
        !admitted.purchases.some(
          (item) => item.purchaseId === target.entityId,
        ) ||
        input.kind !== "manual_upload"
      )
        throw new Error(
          "Validation upload does not name admitted Purchase work.",
        );
    }
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
      sourceMetadata:
        target.purpose === "purchase_validation"
          ? {
              researchUploadState: "pending",
              filename: safeFilename(input.filename),
            }
          : input.sourceMetadata,
    });
    const expiresIn = 300;
    const grant = await signJWT(
      {
        typ: "run-evidence-upload",
        evidenceId,
        runId: target.runId,
        actorUserId,
        checksum: input.checksum,
        byteSize: input.byteSize,
        mediaType: input.contentType,
      },
      env.BETTER_AUTH_SECRET,
      expiresIn,
    );
    const uploadUrl = new URL(
      "/api/import/evidence",
      getExecutionCtx()?.origin ?? env.BETTER_AUTH_URL ?? APP_ORIGIN,
    );
    uploadUrl.searchParams.set("grant", grant);
    return initiateRunEvidenceUploadOut.parse({
      evidenceId,
      objectKey,
      uploadUrl: uploadUrl.href,
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    });
  });
}

const uploadGrant = z.object({
  typ: z.literal("run-evidence-upload"),
  evidenceId: z.uuid(),
  runId: runEntityId,
  actorUserId: userId,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  byteSize: initiateRunEvidenceUploadInput.shape.byteSize,
  mediaType: initiateRunEvidenceUploadInput.shape.contentType,
  exp: z.number().int(),
});

/** A delayed capability must pass the durable Run fence before every storage PUT. */
export async function receiveRunEvidenceUpload(
  db: Database,
  request: Request,
  storage: Pick<
    BrowserEvidenceStorage,
    "put"
  > = productionBrowserEvidenceStorage,
): Promise<Response> {
  if (request.method !== "PUT")
    return new Response("Use PUT", { status: 405, headers: { allow: "PUT" } });
  const token = new URL(request.url).searchParams.get("grant");
  if (!token) return new Response("Upload grant missing", { status: 401 });
  const claims = uploadGrant.safeParse(
    await verifyJWT(token, env.BETTER_AUTH_SECRET),
  );
  if (!claims.success || claims.data.exp <= Math.floor(Date.now() / 1_000))
    return new Response("Upload grant invalid or expired", { status: 401 });
  const grant = claims.data;
  if (request.headers.get("content-type") !== grant.mediaType)
    return new Response("Upload content type differs from its grant", {
      status: 415,
    });
  const bytes = await readResponseWithLimit(
    new Response(request.body, { headers: request.headers }),
    grant.byteSize,
  );
  if (
    bytes.byteLength !== grant.byteSize ||
    (await sha256Hex(bytes)) !== grant.checksum
  )
    return new Response("Upload bytes differ from the retained manifest", {
      status: 422,
    });
  return withTransaction(db, async (client) => {
    const [owned] = await client
      .select({ evidence: runEvidence })
      .from(runEvidence)
      .innerJoin(runTable, eq(runTable.id, runEvidence.runId))
      .innerJoin(
        runTarget,
        and(
          eq(runTarget.id, runEvidence.targetId),
          eq(runTarget.runId, runTable.id),
        ),
      )
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, runTable.ledgerPartyId),
          eq(ledgerParty.userId, grant.actorUserId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          eq(runEvidence.id, grant.evidenceId),
          eq(runTable.id, grant.runId),
          eq(runTable.actorUserId, grant.actorUserId),
          isNull(runTable.retiredAt),
          notDeleted(runTable),
          inArray(runTable.status, ["running", "dispatch_failed"]),
          inArray(runTarget.state, ["pending", "prepared", "needs_evidence"]),
          eq(runEvidence.checksum, grant.checksum),
          eq(runEvidence.byteSize, grant.byteSize),
          eq(runEvidence.mediaType, grant.mediaType),
        ),
      )
      .for("update", { of: runTable });
    if (!owned)
      return new Response(
        "Evidence work is retired, settled, or no longer owned",
        { status: 409 },
      );
    // The existing manifest survives a failed PUT. Retirement takes this same
    // Run lock and cannot finish deletion before an admitted upload settles.
    await storage.put(owned.evidence.objectKey, bytes, grant.mediaType);
    const staged = z
      .object({
        researchUploadState: z.literal("pending"),
        filename: z.string(),
      })
      .safeParse(owned.evidence.sourceMetadata);
    if (staged.success)
      await client
        .update(runEvidence)
        .set({
          sourceMetadata: { ...staged.data, researchUploadState: "uploaded" },
        })
        .where(eq(runEvidence.id, owned.evidence.id));
    return new Response(null, { status: 204 });
  });
}

const retainedMediaSelection = initiateRunEvidenceUploadInput
  .pick({
    runId: true,
    targetId: true,
  })
  .extend({ evidenceId: z.uuid() });

/** Read immutable originals through the same ownership and retirement fence as uploads. */
export async function readRunEvidenceMedia(
  db: Database,
  selection: z.input<typeof retainedMediaSelection>,
  actorUserId: string,
  readObject: (key: string) => Promise<Response> = getS3Object,
): Promise<Response> {
  const input = retainedMediaSelection.parse(selection);
  const actor = userId.parse(actorUserId);
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
  return withTransaction(db, async (database) => {
    const [owned] = await database
      .select({ evidence: runEvidence })
      .from(runEvidence)
      .innerJoin(runTable, eq(runTable.id, runEvidence.runId))
      .innerJoin(
        runTarget,
        and(
          eq(runTarget.id, runEvidence.targetId),
          eq(runTarget.runId, runTable.id),
        ),
      )
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, runTable.ledgerPartyId),
          eq(ledgerParty.userId, actor),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          eq(runTable.shortcode, input.runId),
          eq(runTable.actorUserId, actor),
          notDeleted(runTable),
          isNull(runTable.retiredAt),
          eq(runTarget.id, input.targetId),
          eq(runEvidence.id, input.evidenceId),
        ),
      )
      .limit(1)
      .for("update", { of: runTable });
    if (!owned)
      return new Response(
        "Retained evidence is unavailable or no longer owned",
        { status: 404, headers },
      );
    const evidence = owned.evidence;
    const mediaType =
      initiateRunEvidenceUploadInput.shape.contentType.safeParse(
        evidence.mediaType,
      );
    const size = initiateRunEvidenceUploadInput.shape.byteSize.safeParse(
      evidence.byteSize,
    );
    const staged = z
      .object({ researchUploadState: z.literal("pending") })
      .safeParse(evidence.sourceMetadata);
    if (staged.success)
      return new Response("Retained evidence upload is pending", {
        status: 409,
        headers,
      });
    if (!mediaType.success || !size.success)
      return new Response(
        "Retained evidence cannot be displayed as verified media",
        { status: 415, headers },
      );
    const original = await readObject(evidence.objectKey);
    if (!original.ok)
      return new Response(await original.text(), {
        status: original.status,
        headers,
      });
    const bytes = await readResponseWithLimit(original, size.data);
    if (
      bytes.byteLength !== size.data ||
      (await sha256Hex(bytes)) !== evidence.checksum
    )
      return new Response(
        "Retained evidence bytes differ from their manifest",
        { status: 422, headers },
      );
    return new Response(bytes, {
      headers: {
        ...headers,
        "Content-Type": mediaType.data,
        "Content-Length": String(bytes.byteLength),
      },
    });
  });
}
