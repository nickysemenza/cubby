import type { ActorContext } from "@cubby/schemas/context";
import { runEntityId, vendorAccountId } from "@cubby/schemas/identifiers";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import {
  listReceiptHuntsOut,
  submitReceiptEvidenceInput,
  submitReceiptEvidenceOut,
  type SubmitReceiptEvidenceInput,
} from "@cubby/schemas/purchase-import";
import {
  researchAttachmentOriginal,
  RESEARCH_ATTACHMENT_MAX_BYTES,
} from "@cubby/schemas/research-tools";
import {
  researchObjectivesRunInput,
  type RunCause,
} from "@cubby/schemas/run-fields";
import { readResponseWithLimit } from "@cubby/shared/external-fetch";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  financialTransaction,
  financialAccount,
  image,
  importHunt,
  run as runTable,
  runTarget,
  ledgerParty,
  user,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { cents } from "~/server/repo/money";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { getS3Object } from "~/server/utils/s3";

import { dispatchRunEvent } from "./dispatch";
import type { ResearchAttachmentReader } from "./research-mail-attachments";
import {
  admitResearchObjectiveTargets,
  OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
  researchObjectivesOf,
} from "./research-objective";
import {
  assertReceiptObjectiveOriginal,
  researchObjectiveFor,
} from "./research-objective-context";

/**
 * A hunt—not a particular upload—is the durable receipt source. A retry may
 * replace an unreadable photo, but it must refresh the same source claim so a
 * redeploy or a second attempt cannot manufacture a second Purchase.
 */
export const receiptHuntSourceIdentity = (input: {
  huntId: string;
  checksum: string;
}) => ({
  kind: "receipt_photo" as const,
  externalKey: `hunt:${input.huntId}`,
  checksum: input.checksum,
});

export async function listReceiptHunts(db: Database, actor: ActorContext) {
  const rows = await getDb(db)
    .select({
      id: importHunt.id,
      transactionDate: financialTransaction.transactionDate,
      merchant: financialTransaction.merchant,
      amount: financialTransaction.amount,
    })
    .from(importHunt)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, importHunt.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .innerJoin(
      financialTransaction,
      and(
        eq(financialTransaction.id, importHunt.financialTransactionId),
        notDeleted(financialTransaction),
      ),
    )
    .innerJoin(
      financialAccount,
      and(
        eq(financialAccount.id, financialTransaction.accountId),
        eq(financialAccount.ledgerPartyId, importHunt.ledgerPartyId),
        notDeleted(financialAccount),
      ),
    )
    .where(
      or(
        inArray(importHunt.state, ["receipt_required", "receipt_failed"]),
        and(
          eq(importHunt.state, "processing_receipt"),
          lt(importHunt.updatedAt, new Date(Date.now() - 15 * 60_000)),
        ),
      ),
    )
    .orderBy(importHunt.dateFrom);

  return listReceiptHuntsOut.parse({
    items: rows.map((row) => ({
      id: row.id,
      transactionDate: row.transactionDate,
      merchant: row.merchant,
      amountInCents: cents(Math.abs(row.amount)),
    })),
  });
}

export async function loadPriorReceiptObjective(
  tx: DrizzleTransaction,
  hunt: Pick<
    typeof importHunt.$inferSelect,
    "id" | "ledgerPartyId" | "receiptRunId" | "receiptImageId"
  >,
) {
  if (!hunt.receiptRunId || !hunt.receiptImageId)
    throw new Error("Receipt evidence is processing without an import run.");
  const [predecessor] = await tx
    .select()
    .from(runTable)
    .where(
      and(
        eq(runTable.id, runEntityId.parse(hunt.receiptRunId)),
        eq(runTable.ledgerPartyId, hunt.ledgerPartyId),
        notDeleted(runTable),
      ),
    )
    .for("no key update")
    .limit(1);
  if (!predecessor) throw new Error("Receipt import run could not be resumed.");
  let original = researchObjectivesOf(predecessor.input)?.objectives.find(
    (objective) =>
      objective.kind === "receipt_hunt" && objective.huntId === hunt.id,
  );
  const legacy =
    predecessor.input === null && predecessor.purpose === "account_sync";
  if (legacy) {
    if (
      predecessor.retiredAt ||
      ["user_cancelled", "dispatch_aborted"].includes(
        predecessor.failureCode ?? "",
      ) ||
      !["completed", "needs_review", "failed", "dispatch_failed"].includes(
        predecessor.status,
      )
    )
      throw new Error(
        "Stop the legacy receipt Run before admitting fresh research.",
      );
    const [retained] = await tx
      .select()
      .from(image)
      .where(
        and(
          eq(image.id, hunt.receiptImageId),
          eq(image.status, "UPLOADED"),
          notDeleted(image),
        ),
      )
      .for("share")
      .limit(1);
    if (!retained?.sha256)
      throw new Error(
        "Legacy receipt original is not finalized or has no checksum.",
      );
    original = {
      kind: "receipt_hunt",
      huntId: hunt.id,
      imageId: retained.id,
      checksum: retained.sha256,
    };
  }
  if (
    original?.kind !== "receipt_hunt" ||
    original.imageId !== hunt.receiptImageId
  )
    throw new Error(
      "Receipt hunt no longer matches its frozen original objective.",
    );
  return { predecessor, original, legacy };
}

export async function submitReceiptEvidence(
  db: Database,
  rawInput: SubmitReceiptEvidenceInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
) {
  const input = submitReceiptEvidenceInput.parse(rawInput);
  const imageId = await resolveOrThrow(db, "image", input.imageId);
  const claimed = await withTransaction(db, async (tx) => {
    const [row] = await tx
      .select({
        id: importHunt.id,
        ledgerPartyId: importHunt.ledgerPartyId,
        vendorId: importHunt.vendorId,
        vendorAccountId: importHunt.vendorAccountId,
        receiptImageId: importHunt.receiptImageId,
        receiptRunId: importHunt.receiptRunId,
        state: importHunt.state,
        updatedAt: importHunt.updatedAt,
        imageChecksum: image.sha256,
        actorUserId: ledgerParty.userId,
        actorName: user.name,
        actorEmail: user.email,
        actorLedgerPartyShortcode: ledgerParty.shortcode,
        actorLedgerPartyName: ledgerParty.name,
        actorLedgerPartyKind: ledgerParty.kind,
      })
      .from(importHunt)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, importHunt.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .innerJoin(
        image,
        and(
          eq(image.id, imageId),
          eq(image.status, "UPLOADED"),
          isNotNull(image.sha256),
          notDeleted(image),
        ),
      )
      .innerJoin(user, eq(user.id, ledgerParty.userId))
      .innerJoin(
        financialTransaction,
        and(
          eq(financialTransaction.id, importHunt.financialTransactionId),
          notDeleted(financialTransaction),
        ),
      )
      .innerJoin(
        financialAccount,
        and(
          eq(financialAccount.id, financialTransaction.accountId),
          eq(financialAccount.ledgerPartyId, importHunt.ledgerPartyId),
          notDeleted(financialAccount),
        ),
      )
      .where(eq(importHunt.id, input.huntId))
      .limit(1)
      .for("update", { of: importHunt });
    if (!row)
      throw new Error(
        "Receipt hunt or finalized image was not found for this member.",
      );
    if (!row.actorUserId)
      throw new Error("Receipt party has no controlling member.");
    let predecessor: typeof runTable.$inferSelect | undefined;
    let cause: RunCause = "source_discovered";
    if (row.receiptImageId) {
      const prior = await loadPriorReceiptObjective(tx, row);
      predecessor = prior.predecessor;
      const { original } = prior;
      cause =
        original.checksum === row.imageChecksum ? "retry" : "evidence_changed";
      const terminal = [
        "completed",
        "needs_review",
        "failed",
        "dispatch_failed",
      ].includes(predecessor.status);
      if (!prior.legacy && original.checksum === row.imageChecksum) {
        return {
          ...row,
          runId: predecessor.id,
          publicId: predecessor.shortcode,
          shouldEnqueue: !terminal && !predecessor.retiredAt,
          created: false,
          dispatchEventId: null,
        };
      }
      const retryable =
        row.state === "receipt_failed" ||
        row.state === "deferred_for_review" ||
        (row.state === "processing_receipt" &&
          row.updatedAt < new Date(Date.now() - 15 * 60_000));
      if (!retryable) {
        throw new Error("This receipt hunt already has different evidence.");
      }
    }
    const runId = runEntityId.parse(crypto.randomUUID());
    const dispatchEventId = crypto.randomUUID();
    const objectives = researchObjectivesRunInput.parse({
      kind: "research_objectives",
      instructionRevision: OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
      objectives: [
        {
          kind: "receipt_hunt",
          huntId: row.id,
          imageId,
          checksum: row.imageChecksum,
        },
      ],
    });
    const run = await insertWithShortcode(tx, "run", {
      id: runId,
      ledgerPartyId: row.ledgerPartyId,
      actorUserId: row.actorUserId,
      actorName: row.actorName,
      actorEmail: row.actorEmail,
      actorLedgerPartyShortcode: row.actorLedgerPartyShortcode,
      actorLedgerPartyName: row.actorLedgerPartyName,
      actorLedgerPartyKind: row.actorLedgerPartyKind,
      vendorAccountId: row.vendorAccountId
        ? vendorAccountId.parse(row.vendorAccountId)
        : null,
      vendorId: row.vendorId,
      parentRunId: predecessor?.parentRunId ?? null,
      predecessorRunId: row.receiptRunId
        ? runEntityId.parse(row.receiptRunId)
        : null,
      trigger: "discovery",
      cause,
      attempt: predecessor
        ? predecessor.attempt === null
          ? null
          : predecessor.attempt + 1
        : 1,
      input: objectives,
      coordinatorModel: coordinatorModelFor("account_sync"),
      agentSessionId: importRunAgentIdentity(runId, "account_sync"),
      dispatchEventId,
    });
    await admitResearchObjectiveTargets(tx, { runId, objectives });
    await tx
      .update(importHunt)
      .set({
        receiptImageId: imageId,
        receiptRunId: run.id,
        receiptQueuedAt: new Date(),
        state: "processing_receipt",
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(importHunt.id, row.id));
    return {
      ...row,
      runId: run.id,
      publicId: run.shortcode,
      shouldEnqueue: true,
      created: true,
      dispatchEventId,
    };
  });

  if (!claimed.shouldEnqueue || !claimed.runId || !claimed.publicId) {
    return submitReceiptEvidenceOut.parse({
      huntId: input.huntId,
      imageId: input.imageId,
      queued: false,
    });
  }
  if (!claimed.imageChecksum)
    throw new Error("Finalized receipt image is missing its checksum.");
  await dispatchRunEvent(db, queue, {
    version: 1,
    runId: claimed.runId,
    eventId: claimed.created
      ? (claimed.dispatchEventId ??
        `receipt:${input.huntId}:${claimed.imageChecksum}`)
      : `receipt-retry:${input.huntId}:${claimed.imageChecksum}`,
    type: claimed.created ? "start_or_resume" : "retry",
  });

  return submitReceiptEvidenceOut.parse({
    huntId: input.huntId,
    imageId: input.imageId,
    queued: true,
  });
}

/** Selected receipt bytes are authorized before storage access and rechecked afterward. */
export async function readReceiptResearchOriginal(
  db: Database,
  scope: typeof runTable.$inferSelect,
  target: typeof runTarget.$inferSelect,
  read: ResearchAttachmentReader = async (key, maxBytes) => {
    const response = await getS3Object(key);
    if (!response.ok)
      throw new Error(
        `Receipt original read failed: ${response.status} ${response.statusText}`,
      );
    return readResponseWithLimit(response, maxBytes);
  },
) {
  const objective = researchObjectiveFor(scope, target);
  if (objective?.kind !== "receipt_hunt") return null;
  const { original } = await assertReceiptObjectiveOriginal(
    db,
    scope,
    objective,
  );
  const descriptor = researchAttachmentOriginal
    .omit({ dataBase64: true })
    .parse({
      attachmentRef: original.id,
      filename: original.filename,
      mimeType: original.contentType,
      checksum: objective.checksum,
    });
  const bytes = await read(original.key, RESEARCH_ATTACHMENT_MAX_BYTES);
  if (bytes.byteLength > RESEARCH_ATTACHMENT_MAX_BYTES)
    throw new Error(
      "Receipt original exceeds the 3 MiB byte limit; a larger-document capability is required.",
    );
  if ((await sha256Hex(bytes)) !== objective.checksum)
    throw new Error("Selected receipt original bytes changed.");
  await assertReceiptObjectiveOriginal(db, scope, objective);
  return researchAttachmentOriginal.parse({
    ...descriptor,
    dataBase64: Buffer.from(bytes).toString("base64"),
  });
}
