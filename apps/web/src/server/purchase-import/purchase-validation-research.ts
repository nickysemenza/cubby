import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  runEntityId,
  type LedgerPartyId,
  type PurchaseId,
  type RunId,
  type UserId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { researchImportResult } from "@cubby/schemas/mailbox-research";
import {
  acceptedSourceOrder,
  proposedImportFix,
  validationDiff,
  validationExpectedPlan,
  type ValidationExpectedPlan,
} from "@cubby/schemas/purchase-import";
import {
  researchAttachmentOriginal,
  RESEARCH_ATTACHMENT_MAX_BYTES,
  type ResearchWorkResolution,
} from "@cubby/schemas/research-tools";
import { purchaseValidationResearchRunInput } from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { readResponseWithLimit } from "@cubby/shared/external-fetch";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  purchase,
  run,
  runEvidence,
  runFinding,
  runOperation,
  runTarget,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";
import { readCanonicalEntityIds } from "~/server/repo/entity-identity";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { actorSnapshot } from "~/server/runs/ensure-run";
import { inheritExecutionAuthorization } from "~/server/runs/execution-context";
import { getS3Object } from "~/server/utils/s3";

import { browsingAccountFor, browsingAccounts } from "./browsing-account";
import {
  dispatchRunEvent,
  recordRunDispatchAttempt,
  researchDispatchPending,
} from "./dispatch";
import {
  readResearchContinuationSuccessor,
  researchContinuationAdmission,
  type ResearchContinuation,
} from "./research-continuation-admission";
import { assertResearchTaskAdmission } from "./research-execution";
import type { ResearchAttachmentReader } from "./research-mail-attachments";
import {
  authorizeResearchRetirement,
  readResearchRetirementSuccessor,
  researchRetirementAdmission,
} from "./research-retention-admission";
import {
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "./source-claim-family";
import {
  loadLiveValidationState,
  applyValidationCorrections,
} from "./validation-corrections";
import {
  compareValidationPlan,
  PURCHASE_CURRENCY,
} from "./validation-corrections-compare";
import { buildPurchaseImportPlan } from "./writer";

const INSTRUCTION_REVISION = 1;
type Client = DrizzleClient | DrizzleTransaction;
type Scope = typeof run.$inferSelect;
type Target = typeof runTarget.$inferSelect;
type AdmittedPurchase = z.infer<
  typeof purchaseValidationResearchRunInput
>["purchases"][number];
type Selection = { purchaseId: PurchaseId; sourceOrderId: string };

class SelectedValidationSourceError extends Error {}

async function selectedOriginal(
  client: Client,
  owner: LedgerPartyId,
  purchaseId: PurchaseId,
  sourceOrderId: string | null,
  lock?: "share",
) {
  if (!sourceOrderId) return null;
  const [selected] = await client
    .select({ association: importSourceOrder, claim: importSourceClaim })
    .from(importSourceOrder)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .where(eq(importSourceOrder.id, sourceOrderId));
  if (
    !selected ||
    selected.claim.ledgerPartyId !== owner ||
    selected.association.purchaseId !== purchaseId
  )
    throw new SelectedValidationSourceError(
      "Selected validation source is not owned or does not support this Purchase.",
    );
  const family = await readImportSourceClaimFamily(client, selected.claim, {
    lock,
  });
  const retained =
    family &&
    (await readSourceFamilyOrder(
      client,
      family,
      selected.association.orderKey,
      lock,
    ));
  const original = acceptedSourceOrder.safeParse(
    retained?.association.originalOrder,
  );
  if (
    !family ||
    !retained ||
    retained.association.id !== sourceOrderId ||
    retained.association.purchaseId !== purchaseId ||
    family.root.checksum !== retained.association.checksum ||
    !original.success ||
    original.data.checksum !== retained.association.checksum
  )
    throw new SelectedValidationSourceError(
      "Selected validation source is stale or lacks a current accepted original.",
    );
  return {
    source: {
      sourceRef: retained.association.id,
      checksum: retained.association.checksum,
      kind: family.root.kind,
      externalKey: family.root.externalKey,
      original: original.data,
    },
    vendorAccountId: retained.claim.vendorAccountId,
  };
}

async function optionalBrowserTransport(
  db: Database,
  owner: LedgerPartyId,
  vendorId: VendorId,
  preferredAccountId: string | null,
  lock = false,
) {
  const accounts = (await browsingAccounts(db, [vendorId])).filter(
    (account) => account.ledgerPartyId === owner,
  );
  const chosen = browsingAccountFor(accounts, {
    vendorId,
    vendorAccountId: preferredAccountId,
  });
  if (!chosen) return null;
  const query = getDb(db)
    .select({
      id: vendorAccount.id,
      shortcode: vendorAccount.shortcode,
      label: vendorAccount.label,
    })
    .from(vendorAccount)
    .where(
      and(
        eq(vendorAccount.id, chosen.id),
        eq(vendorAccount.ledgerPartyId, owner),
        eq(vendorAccount.browser, "chrome"),
        eq(vendorAccount.browserSyncEnabled, true),
        ne(vendorAccount.status, "disabled"),
        notDeleted(vendorAccount),
      ),
    );
  const [account] = await (lock ? query.for("share") : query);
  return account ?? null;
}

export async function previewPurchaseValidationSource(
  db: Database,
  owner: LedgerPartyId,
  purchaseId: PurchaseId,
  sourceOrderId: string,
) {
  let original;
  try {
    original = await selectedOriginal(
      getDb(db),
      owner,
      purchaseId,
      sourceOrderId,
    );
  } catch (error) {
    if (!(error instanceof SelectedValidationSourceError)) throw error;
    return { usable: false, reason: error.message, account: null };
  }
  const [header] = await getDb(db)
    .select({ vendorId: purchase.vendorId })
    .from(purchase)
    .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)));
  if (!header) throw new Error("Validation Purchase is unavailable.");
  const account = await optionalBrowserTransport(
    db,
    owner,
    header.vendorId,
    original?.vendorAccountId ?? null,
  );
  return { usable: true, reason: null, account };
}

async function validationContext(
  db: Database,
  owner: LedgerPartyId,
  id: PurchaseId,
  selection: AdmittedPurchase["selectedSource"],
  lock = false,
) {
  const client = getDb(db);
  // Source roots precede the Purchase and Run locks, matching the import writer.
  const original = await selectedOriginal(
    client,
    owner,
    id,
    selection?.sourceOrderId ?? null,
    lock ? "share" : undefined,
  );
  const source = original?.source ?? null;
  if (selection && source?.checksum !== selection.checksum)
    throw new Error("Frozen validation source checksum changed.");
  const live = await loadLiveValidationState(db, id, {
    lock,
    requireLive: true,
  });
  if (!live) throw new Error("Validation Purchase is unavailable.");
  const [header] = await client
    .select({
      purchase: purchase,
      vendor: { name: vendor.name, website: vendor.website },
    })
    .from(purchase)
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .where(and(eq(purchase.id, id), notDeleted(purchase)));
  if (!header) throw new Error("Validation Purchase or Vendor is unavailable.");
  const current = { purchase: header.purchase, lines: live.lines, source };
  return {
    ...current,
    live,
    vendor: header.vendor,
    fingerprint: await sha256Hex(JSON.stringify(current)),
  };
}

function admittedPurchase(scope: Scope, target: Target) {
  const input = purchaseValidationResearchRunInput.parse(scope.input);
  const saved = input.purchases.find(
    (item) => item.purchaseId === target.workKey,
  );
  if (
    scope.purpose !== "purchase_validation" ||
    target.runId !== scope.id ||
    target.entityKind !== "purchase" ||
    !saved
  )
    throw new Error("Validation work does not name an admitted Purchase.");
  return saved;
}

async function selectedValidationContexts(
  tx: DrizzleTransaction,
  owner: LedgerPartyId,
  ids: readonly PurchaseId[],
  selections: readonly Selection[],
) {
  if (selections.some((source) => !ids.includes(source.purchaseId)))
    throw new Error(
      "Selected validation source is outside the Purchase roster.",
    );
  const contexts = [];
  for (const id of ids) {
    const selected = selections.filter((source) => source.purchaseId === id);
    if (selected.length > 1)
      throw new Error(
        "Choose one original source preference per validation Purchase.",
      );
    const original = await selectedOriginal(
      tx,
      owner,
      id,
      selected[0]?.sourceOrderId ?? null,
      "share",
    );
    const selection = original
      ? {
          sourceOrderId: original.source.sourceRef,
          checksum: original.source.checksum,
        }
      : null;
    const context = await validationContext(
      databaseForTransaction(tx),
      owner,
      id,
      selection,
      true,
    );
    const account = original
      ? await optionalBrowserTransport(
          databaseForTransaction(tx),
          owner,
          context.purchase.vendorId,
          original.vendorAccountId,
          true,
        )
      : null;
    contexts.push({
      id,
      selection,
      context,
      account,
    });
  }
  return contexts;
}

function assertValidationContinuationMode(
  input: Parameters<typeof admitPurchaseValidationResearch>[1],
) {
  if (input.continuation && input.retirementReceiptId)
    throw new Error("Choose ordinary continuation or a retirement receipt.");
  if (Boolean(input.parentRunId) !== Boolean(input.retirementReceiptId))
    throw new Error(
      "Validation retirement requires its predecessor and receipt.",
    );
}

async function readValidationSuccessor(
  tx: DrizzleTransaction,
  ordinary: Parameters<typeof readResearchContinuationSuccessor>[1],
  retirement: Parameters<typeof authorizeResearchRetirement>[1],
) {
  const successor = await readResearchContinuationSuccessor(tx, ordinary);
  if (successor) return { successor, authority: null };
  const authority = await authorizeResearchRetirement(tx, retirement);
  const retiredSuccessor = await readResearchRetirementSuccessor(tx, authority);
  if (!retiredSuccessor && authority)
    await assertResearchTaskAdmission(
      databaseForTransaction(tx),
      authority.predecessor.id,
    );
  return {
    successor: retiredSuccessor,
    authority,
  };
}

function validationRunLineage(
  continuation:
    | Awaited<ReturnType<typeof researchContinuationAdmission>>
    | Awaited<ReturnType<typeof researchRetirementAdmission>>,
) {
  if (continuation)
    return {
      cause: "retry" as const,
      parentRunId: continuation.parentRunId,
      predecessorRunId: continuation.predecessorRunId,
      attempt: continuation.attempt,
      clientKey: continuation.clientKey,
    };
  return {
    cause: "member_request" as const,
    parentRunId: null,
    predecessorRunId: null,
    attempt: 1,
    clientKey: null,
  };
}

/** One admission for manual launches and fresh continuations; no vendor/browser choreography. */
export async function admitPurchaseValidationResearch(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    userId: UserId;
    purchaseIds: readonly PurchaseId[];
    selectedSources?: readonly Selection[];
    manualEvidenceUnavailable?: boolean;
    continuation?: ResearchContinuation;
    parentRunId?: RunId;
    retirementReceiptId?: string;
  },
) {
  return withTransaction(db, async (tx) => {
    const [owner] = await tx
      .select()
      .from(ledgerParty)
      .where(
        and(
          eq(ledgerParty.id, input.ledgerPartyId),
          eq(ledgerParty.userId, input.userId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      // Serialize admission while allowing source claims to reference this member.
      .for("no key update");
    if (!owner)
      throw new Error("Validation admission requires the owning member.");
    assertValidationContinuationMode(input);
    const scope = {
      ledgerPartyId: owner.id,
      actorUserId: input.userId,
      purpose: "purchase_validation" as const,
      continuation: input.continuation,
    };
    const retirementInput = {
      receiptId: input.retirementReceiptId,
      parentRunId: input.parentRunId,
      ledgerPartyId: owner.id,
      actorUserId: input.userId,
      purpose: "purchase_validation" as const,
      taskKeys: input.purchaseIds,
    };
    const { successor, authority } = await readValidationSuccessor(
      tx,
      scope,
      retirementInput,
    );
    if (successor) return { row: successor, created: false };
    const ids = [...new Set(input.purchaseIds)].sort();
    if (
      !ids.length ||
      ids.length > 50 ||
      ids.length !== input.purchaseIds.length
    )
      throw new Error("Validation requires one to fifty distinct Purchases.");
    const contexts = await selectedValidationContexts(
      tx,
      owner.id,
      ids,
      input.selectedSources ?? [],
    );
    const continuation =
      (await researchContinuationAdmission(tx, {
        ...scope,
        taskKeys: ids,
      })) ?? (await researchRetirementAdmission(tx, retirementInput));
    const racedSuccessor = await readResearchRetirementSuccessor(
      tx,
      continuation,
    );
    if (racedSuccessor) return { row: racedSuccessor, created: false };
    if (!continuation) {
      const [held] = await tx
        .select({ row: run })
        .from(runTarget)
        .innerJoin(run, eq(run.id, runTarget.runId))
        .where(
          and(
            eq(run.ledgerPartyId, owner.id),
            eq(run.purpose, "purchase_validation"),
            inArray(run.status, [...ACTIVE_RUN_STATUSES]),
            notDeleted(run),
            eq(runTarget.entityKind, "purchase"),
            inArray(runTarget.entityId, ids),
          ),
        )
        .limit(1);
      if (held) return { row: held.row, created: false };
    }
    const typed = purchaseValidationResearchRunInput.parse({
      kind: "purchase_validation_research",
      instructionRevision: INSTRUCTION_REVISION,
      purchases: contexts.map(({ id, selection, context }) => ({
        purchaseId: id,
        manualEvidenceUnavailable:
          input.manualEvidenceUnavailable ??
          (authority
            ? purchaseValidationResearchRunInput
                .parse(authority.predecessor.input)
                .purchases.find((item) => item.purchaseId === id)
                ?.manualEvidenceUnavailable
            : false),
        selectedSource: selection,
        contextFingerprint: context.fingerprint,
      })),
    });
    const snapshot = await actorSnapshot(tx, input.userId);
    const accountIds = [
      ...new Set(
        contexts.flatMap(({ account }) => (account ? [account.id] : [])),
      ),
    ];
    const id = runEntityId.parse(crypto.randomUUID());
    const row = await insertWithShortcode(tx, "run", {
      id,
      ledgerPartyId: owner.id,
      vendorAccountId: accountIds.length === 1 ? accountIds[0] : null,
      actorUserId: input.userId,
      actorName: snapshot.actorName,
      actorEmail: snapshot.actorEmail,
      actorLedgerPartyShortcode: owner.shortcode,
      actorLedgerPartyName: owner.name,
      actorLedgerPartyKind: owner.kind,
      purpose: "purchase_validation",
      trigger: "manual",
      ...validationRunLineage(continuation),
      status: "running",
      input:
        (await inheritExecutionAuthorization(tx, typed, {
          parentRunId: continuation?.parentRunId,
          predecessorRunId: continuation?.predecessorRunId,
        })) ?? null,
      coordinatorModel: coordinatorModelFor("purchase_validation"),
      dispatchEventId: crypto.randomUUID(),
      agentSessionId: importRunAgentIdentity(id, "purchase_validation"),
    });
    await tx.insert(runTarget).values(
      contexts.map(({ id, selection, context }) => ({
        runId: row.id,
        entityKind: "purchase" as const,
        entityId: id,
        workKey: id,
        state: selection ? "pending" : "needs_evidence",
        targetFingerprint: context.fingerprint,
        evidenceFingerprint: selection?.checksum ?? null,
      })),
    );
    return { row, created: true };
  });
}

export async function startPurchaseValidationResearch(
  db: Database,
  input: Parameters<typeof admitPurchaseValidationResearch>[1],
  queue?: PurchaseAgentQueueProducer,
) {
  const admission = await admitPurchaseValidationResearch(db, input);
  if (researchDispatchPending(admission.row))
    await runAfterCommit(db, async (committedDb) => {
      const producer = queue ?? getPurchaseAgentQueue();
      if (!admission.row.dispatchEventId)
        throw new Error(
          "Validation research dispatch identity is unavailable.",
        );
      if (!producer) {
        await recordRunDispatchAttempt(committedDb, {
          runId: admission.row.id,
          eventId: admission.row.dispatchEventId,
          error: "Purchase research queue is unavailable",
        });
        return;
      }
      await dispatchRunEvent(committedDb, producer, {
        version: 1,
        type: "start_or_resume",
        runId: admission.row.id,
        purpose: "purchase_validation",
        eventId: admission.row.dispatchEventId,
      });
    });
  return admission;
}

export async function loadPurchaseValidationContext(
  db: Database,
  scope: Scope,
  target: Target,
  lock = false,
) {
  const saved = admittedPurchase(scope, target);
  if (!scope.ledgerPartyId)
    throw new Error("Validation member ownership is unavailable.");
  const current = await readCanonicalEntityIds(db, "purchase", [
    saved.purchaseId,
  ]);
  if (current.get(saved.purchaseId) !== target.entityId)
    throw new Error(
      "Validation work differs from its canonical admitted Purchase.",
    );
  const context = await validationContext(
    db,
    parseEntityId("ledgerParty", scope.ledgerPartyId),
    parseEntityId("purchase", target.entityId),
    saved.selectedSource,
    lock,
  );
  if (
    context.fingerprint !== saved.contextFingerprint ||
    target.targetFingerprint !== saved.contextFingerprint
  )
    throw new Error(
      "Recorded Purchase context changed; start fresh validation research.",
    );
  return context;
}

/** Original upload manifests are not proof until the guarded PUT has completed. */
export async function readPurchaseValidationOriginal(
  db: Database,
  scope: Scope,
  target: Target,
  read?: ResearchAttachmentReader,
) {
  await loadPurchaseValidationContext(db, scope, target);
  const originals = await getDb(db)
    .select()
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.runId, scope.id),
        eq(runEvidence.targetId, target.id),
        eq(runEvidence.kind, "manual_upload"),
      ),
    )
    .orderBy(asc(runEvidence.createdAt), asc(runEvidence.id));
  const original = originals.at(-1);
  if (
    !original ||
    !z
      .object({ researchUploadState: z.literal("uploaded") })
      .safeParse(original.sourceMetadata).success
  )
    return null;
  const readBytes =
    read ??
    (async (key: string, limit: number) => {
      const response = await getS3Object(key);
      if (!response.ok)
        throw new Error(
          `Validation original read failed: ${response.status} ${response.statusText}`,
        );
      return readResponseWithLimit(response, limit);
    });
  const bytes = await readBytes(
    original.objectKey,
    RESEARCH_ATTACHMENT_MAX_BYTES,
  );
  if (
    bytes.byteLength > RESEARCH_ATTACHMENT_MAX_BYTES ||
    bytes.byteLength !== original.byteSize ||
    (await sha256Hex(bytes)) !== original.checksum
  )
    throw new Error("Validation original checksum or byte size changed.");
  const metadata = z
    .object({ filename: z.string().optional() })
    .parse(original.sourceMetadata);
  return researchAttachmentOriginal.parse({
    attachmentRef: original.id,
    filename: metadata.filename ?? "Validation original",
    mimeType: original.mediaType,
    checksum: original.checksum,
    dataBase64: Buffer.from(bytes).toString("base64"),
  });
}

/** The assessor's retained envelope must still match this exact uploaded target. */
export async function assertPurchaseValidationOriginal(
  db: Database,
  scope: Scope,
  target: Target,
  input: { evidenceId: string; checksum: string },
) {
  admittedPurchase(scope, target);
  const [original] = await getDb(db)
    .select()
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.id, input.evidenceId),
        eq(runEvidence.runId, scope.id),
        eq(runEvidence.targetId, target.id),
        eq(runEvidence.kind, "manual_upload"),
      ),
    )
    .for("share");
  if (
    !original ||
    original.checksum !== input.checksum ||
    !z
      .object({ researchUploadState: z.literal("uploaded") })
      .safeParse(original.sourceMetadata).success
  )
    throw new Error(
      "Validation original is unuploaded or does not belong to this task.",
    );
  return original;
}

function currentPlan(
  context: Awaited<ReturnType<typeof validationContext>>,
): ValidationExpectedPlan {
  return validationExpectedPlan.parse({
    orderId: context.live.orderId,
    currency: PURCHASE_CURRENCY,
    statedTotal: context.live.statedTotal,
    writeBlockReason: null,
    lines: context.live.lines.map(
      ({ code: _code, explicitProduct: _explicit, ...line }) => line,
    ),
  });
}

/** Only accepted proposal operands generate an advisory diff; canonical records stay untouched. */
export async function projectPurchaseValidation(
  db: Database,
  input: {
    scope: Scope;
    target: Target;
    operationId: string;
    orders: ResearchWorkResolution["orders"];
    facts: ResearchWorkResolution["facts"];
    evidenceIds: readonly string[];
  },
) {
  const context = await loadPurchaseValidationContext(
    db,
    input.scope,
    input.target,
    true,
  );
  const expected = currentPlan(context);
  if (input.orders.length > 1)
    throw new Error(
      "Validation accepts only the exact selected Purchase's order.",
    );
  for (const order of input.orders) {
    if (order.purchaseRef !== context.purchase.shortcode)
      throw new Error("Accepted validation order names a different Purchase.");
    expected.orderId = order.candidate.orderId;
    expected.currency = order.candidate.currency;
    expected.writeBlockReason = buildPurchaseImportPlan({
      status: "ready",
      candidate: order.candidate,
    }).writeBlockReason;
    expected.statedTotal = order.candidate.printedGrandTotal;
    expected.lines = await Promise.all(
      order.candidate.lines.map(async (line, index) => {
        const resolutions = (order.productResolutions ?? []).filter(
          (resolution) => resolution.lineIndex === index,
        );
        if (resolutions.length > 1)
          throw new Error("Validation has duplicate Product resolutions.");
        const resolution = resolutions[0];
        let productRef: string | null = null;
        if (resolution?.kind === "existing") {
          const id = await resolveOrThrow(db, "product", resolution.productId);
          // The existing resolver supplies a shortcode; resolving fences retired/missing records.
          productRef = resolution.productId;
          if (!id)
            throw new Error("Validation Product reference is unavailable.");
        } else if (
          resolution?.kind === "new" ||
          resolution?.kind === "unresolved"
        )
          productRef = resolution.kind;
        return {
          title: line.title,
          amount: line.amount,
          lineKind: line.lineKind,
          quantity:
            resolution?.kind === "expense_only"
              ? null
              : (line.quantity ?? null),
          productId: productRef,
        };
      }),
    );
  }
  for (const fact of input.facts) {
    if (fact.fieldPath === "statedTotal")
      expected.statedTotal = z.number().nullable().parse(fact.value);
    else
      throw new Error(
        `Validation fact is not a supported recorded Purchase field: ${fact.fieldPath}`,
      );
  }
  const comparison = await compareValidationPlan(expected, context.live);
  if (comparison.equal)
    return { needsReview: false, warning: null, review: null };
  const diff = validationDiff.parse({
    version: 2,
    expected,
    actual: {
      orderId: context.live.orderId,
      currency: PURCHASE_CURRENCY,
      statedTotal: context.live.statedTotal,
      lines: context.live.lines.map(
        ({ code: _code, explicitProduct: _explicit, ...line }) => line,
      ),
    },
    corrections: comparison.corrections,
    notes: comparison.notes,
    rawEvidenceDrift: false,
  });
  const reviewFingerprint = await sha256Hex(
    JSON.stringify([input.target.id, context.fingerprint, diff]),
  );
  const fix = comparison.corrections.length
    ? proposedImportFix.parse({
        kind: "validation_corrections",
        purchaseId: context.purchase.id,
        targetId: input.target.id,
        resolutionOperationId: input.operationId,
        reviewSnapshot: { fingerprint: reviewFingerprint },
      })
    : null;
  await getDb(db)
    .update(runTarget)
    .set({ diff })
    .where(eq(runTarget.id, input.target.id));
  await getDb(db)
    .insert(runFinding)
    .values({
      runId: input.scope.id,
      ledgerPartyId: parseEntityId("ledgerParty", input.scope.ledgerPartyId),
      entityKind: "purchase",
      entityId: context.purchase.id,
      kind: "sum_mismatch",
      summary:
        "Supported original differs from the recorded Purchase. Review the proposed corrections; no money was changed.",
      evidenceFingerprint: reviewFingerprint,
      proposedFix: fix,
      autoApplied: false,
    })
    .onConflictDoNothing();
  const evidence = await getDb(db)
    .select({
      id: runEvidence.id,
      checksum: runEvidence.checksum,
      sourceMetadata: runEvidence.sourceMetadata,
    })
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.runId, input.scope.id),
        eq(runEvidence.targetId, input.target.id),
        inArray(runEvidence.id, [...input.evidenceIds]),
      ),
    );
  if (evidence.length !== new Set(input.evidenceIds).size)
    throw new Error("Validation review evidence binding is incomplete.");
  const review = validationReviewReceipt.parse({
    targetId: input.target.id,
    fingerprint: reviewFingerprint,
    diff,
    evidence: await Promise.all(
      evidence.map(async (row) => ({
        id: row.id,
        checksum: row.checksum,
        metadataFingerprint: await sha256Hex(
          JSON.stringify(row.sourceMetadata),
        ),
      })),
    ),
  });
  return {
    needsReview: true,
    warning:
      "Supported original differs from recorded values; member review is required.",
    review,
  };
}

const validationReviewReceipt = z.object({
  targetId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  diff: validationDiff,
  evidence: z
    .array(
      z.object({
        id: z.uuid(),
        checksum: z.string(),
        metadataFingerprint: z.string(),
      }),
    )
    .min(1),
});

async function assertAcceptedValidationReview(
  db: Database,
  scope: Scope,
  target: Target,
  operationId: string,
  fingerprint: string,
  diff: z.infer<typeof validationDiff>,
) {
  const database = getDb(db);
  const [receipt] = await database
    .select()
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, scope.id),
        eq(runOperation.operationId, operationId),
        eq(runOperation.kind, "research_resolve_import"),
        eq(runOperation.state, "completed"),
      ),
    );
  if (!receipt)
    throw new Error(
      "Validation correction has no completed accepted proposal receipt.",
    );
  const accepted = researchImportResult.parse(receipt.result);
  const review = z
    .object({ validationReview: validationReviewReceipt })
    .parse(receipt.result).validationReview;
  if (
    review.targetId !== target.id ||
    review.fingerprint !== fingerprint ||
    JSON.stringify(review.diff) !== JSON.stringify(diff)
  )
    throw new Error(
      "Validation correction does not match the issued accepted proposal.",
    );
  const evidence = await database
    .select()
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.runId, scope.id),
        eq(runEvidence.targetId, target.id),
        inArray(
          runEvidence.id,
          review.evidence.map((item) => item.id),
        ),
      ),
    );
  for (const binding of review.evidence) {
    const row = evidence.find((item) => item.id === binding.id);
    if (
      !row ||
      row.checksum !== binding.checksum ||
      (await sha256Hex(JSON.stringify(row.sourceMetadata))) !==
        binding.metadataFingerprint
    )
      throw new Error(
        "Validation correction's retained evidence changed after review.",
      );
  }
  if (!accepted.proposedOrders.length && !accepted.proposedFacts.length)
    throw new Error(
      "Validation correction has no accepted source-supported operands.",
    );
}

/** The generic finding carries references, never member-supplied financial operands. */
export async function applyPurchaseValidationFinding(
  db: Database,
  actor: ActorContext,
  finding: {
    runId: Scope["id"] | null;
    entityId: string;
    ledgerPartyId: LedgerPartyId;
  },
  fix: Extract<
    z.infer<typeof proposedImportFix>,
    { kind: "validation_corrections" }
  >,
  reviewedFingerprint?: string,
) {
  if (
    !finding.runId ||
    fix.purchaseId !== finding.entityId ||
    reviewedFingerprint !== fix.reviewSnapshot.fingerprint
  )
    throw new Error(
      "Review the current validation snapshot before applying it.",
    );
  const database = getDb(db);
  const [scope] = await database
    .select()
    .from(run)
    .where(
      and(
        eq(run.id, finding.runId),
        eq(run.actorUserId, actor.userId),
        eq(run.ledgerPartyId, finding.ledgerPartyId),
        notDeleted(run),
      ),
    );
  const [target] = await database
    .select()
    .from(runTarget)
    .where(
      and(
        eq(runTarget.id, fix.targetId),
        eq(runTarget.runId, finding.runId),
        eq(runTarget.entityId, fix.purchaseId),
      ),
    );
  if (!scope || !target || scope.retiredAt)
    throw new Error("Validation finding target or owner changed.");
  admittedPurchase(scope, target);
  const context = await loadPurchaseValidationContext(db, scope, target, true);
  const [locked] = await database
    .select()
    .from(run)
    .where(
      and(
        eq(run.id, scope.id),
        eq(run.actorUserId, actor.userId),
        eq(run.ledgerPartyId, finding.ledgerPartyId),
        notDeleted(run),
      ),
    )
    .for("update");
  const [lockedTarget] = await database
    .select()
    .from(runTarget)
    .where(
      and(
        eq(runTarget.id, target.id),
        eq(runTarget.runId, scope.id),
        eq(runTarget.entityId, fix.purchaseId),
      ),
    )
    .for("update");
  if (
    !locked ||
    !lockedTarget ||
    locked.retiredAt ||
    JSON.stringify(locked.input) !== JSON.stringify(scope.input)
  )
    throw new Error("Validation ownership or admitted snapshot changed.");
  const diff = validationDiff.parse(lockedTarget.diff);
  if (
    (await sha256Hex(
      JSON.stringify([target.id, context.fingerprint, diff]),
    )) !== reviewedFingerprint
  )
    throw new Error("Recorded validation snapshot changed after review.");
  await assertAcceptedValidationReview(
    db,
    scope,
    target,
    fix.resolutionOperationId,
    reviewedFingerprint,
    diff,
  );
  const applied = await applyValidationCorrections(
    db,
    {
      runId: scope.shortcode,
      purchaseId: context.purchase.shortcode,
      operationId: `finding:${await sha256Hex(JSON.stringify([fix.targetId, fix.resolutionOperationId]))}`,
      correctionIds: diff.corrections.map((correction) => correction.id),
    },
    actor,
  );
  if (applied.result.status !== "applied")
    throw new Error(
      `Validation correction is stale: ${JSON.stringify(applied.result.stale)}`,
    );
  return applied;
}
