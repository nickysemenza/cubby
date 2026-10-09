import { actorInRun, buildActorContext } from "@cubby/schemas/context";
import {
  GTIN_SOURCE,
  manufacturerSource,
  normalizeGtin,
  type ExternalIdKind,
} from "@cubby/schemas/external-id";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { MAX_IMAGE_UPLOAD_BYTES } from "@cubby/schemas/image";
import {
  retainedResearchObservation,
  type AcceptedResearchFact,
  type ResearchClaimSupport,
} from "@cubby/schemas/research";
import { researchAssessment } from "@cubby/schemas/research-assessment";
import {
  researchWorkResolve,
  type ResearchWorkResolveInput,
} from "@cubby/schemas/research-tools";
import { readResponseWithLimit } from "@cubby/shared/external-fetch";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityAttachment,
  entityExternalId,
  image,
  product,
  run,
  runTarget,
  auditLog,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { lockExternalIdentifierParents } from "~/server/repo/entity-external-ids";
import { reapUnreferencedImages } from "~/server/repo/image";
import { resolveProductIdentifierSource } from "~/server/repo/product-identifier-source";
import { upsertAgentProductMatch } from "~/server/repo/product-match-candidate";
import { executeAtomicOperation } from "~/server/runs/operation";
import {
  deleteStoredObjects,
  importImageFromUrl,
} from "~/server/services/image-storage.service";
import { getS3Object } from "~/server/utils/s3";

import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";
import { recordAcceptedFactEvidence } from "./fact-verification";
import { isProvisionalOrderThumbnail } from "./line-thumbnails";
import { productEnrichmentTarget } from "./product-enrichment-target";
import {
  acceptedProductField,
  commitAcceptedResearchFields,
  loadResearchReferenceContext,
} from "./research-accepted-fields";
import { researchAttemptDisposition } from "./research-attempt";
import { loadProductPurchaseContext } from "./research-context";
import {
  assertResearchWork,
  loadResearchEvidence,
  type ResearchEvidenceReader,
} from "./research-evidence";
import { stageResearchFieldCorrections } from "./research-field-corrections";
import {
  afterProductResearchCommit,
  type ProductResearchEffects,
} from "./research-product-effects";
import {
  loadProductResearchCoverage,
  readResearchCanonicalProjection,
  researchMemberPath,
} from "./research-projection";
import type { ResearchAssessor } from "./research-support";
import { recordRunWrites } from "./run-audit";

const productResearchResult = z.object({
  outcome: researchWorkResolve.shape.status,
  changedFields: z.array(z.string()),
  verifiedFields: z.array(z.string()),
  refusals: researchAssessment.shape.rejected,
  contradictions: z.array(
    z.object({
      fieldPath: z.string(),
      currentValue: z.json(),
      proposedValue: z.json(),
    }),
  ),
});
type Proposal = z.infer<typeof researchWorkResolve>;
type Observations = Awaited<ReturnType<typeof loadResearchEvidence>>;
type IdentifierOperand = {
  evidenceId: string;
  kind: ExternalIdKind;
  externalId: string;
  sourceURL: string;
  support: ResearchClaimSupport;
};
type PreparedImage = {
  row: typeof image.$inferSelect;
  hash: string;
  created: boolean;
  sourceUrl: string;
  evidenceIds: string[];
  support: ResearchClaimSupport;
};
type ProductResearchPorts = ProductResearchEffects & {
  assess?: ResearchAssessor;
  readEvidence?: ResearchEvidenceReader;
  importImage?: typeof importImageFromUrl;
  readImageBytes?: (key: string) => Promise<Uint8Array>;
  deleteImageObjects?: typeof deleteStoredObjects;
};

function operandAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (!value) throw new Error("Assessment accepted a missing operand.");
  return value;
}
function retained(observations: Observations, evidenceIds: readonly string[]) {
  return observations
    .filter((row) => evidenceIds.includes(row.evidenceId))
    .map((row) => {
      const metadata = z
        .object({ research: retainedResearchObservation })
        .parse(row.metadata);
      if (metadata.research.evidenceId !== row.evidenceId)
        throw new Error("Retained observation evidence binding differs.");
      return metadata.research;
    });
}
function visibleIdentifier(
  claim: Proposal["identifierClaims"][number],
  observations: Observations,
): IdentifierOperand {
  const observation = observations.find(
    (row) => row.evidenceId === claim.evidenceId,
  );
  if (!observation) throw new Error("Identifier observation was not retained.");
  const metadata = z
    .object({
      sourceURL: z.url().optional(),
      research: retainedResearchObservation.optional(),
    })
    .parse(observation.metadata);
  if (metadata.research && metadata.research.evidenceId !== claim.evidenceId)
    throw new Error("Retained observation evidence binding differs.");
  const sourceURL =
    metadata.research?.observation.servedURL ??
    metadata.research?.observation.sourceURL ??
    metadata.sourceURL;
  if (!sourceURL)
    throw new Error("Identifier issuer has no retained page URL.");
  return { ...claim, sourceURL };
}
function identifierCandidate(
  selection: Proposal["identifierCandidates"][number],
  observations: Observations,
): IdentifierOperand {
  const candidates = retained(observations, selection.evidenceIds).flatMap(
    (row) =>
      row.identifierCandidates.filter(
        (candidate) =>
          candidate.evidenceId === row.evidenceId &&
          candidate.candidateRef === selection.candidateRef,
      ),
  );
  if (candidates.length !== 1)
    throw new Error(
      "Identifier candidate is not bound to retained task evidence.",
    );
  return { ...candidates[0]!, support: selection.support };
}
function imageCandidate(
  selection: Proposal["imageCandidates"][number],
  observations: Observations,
) {
  const candidates = retained(observations, selection.evidenceIds).flatMap(
    (row) =>
      row.imageCandidates.filter(
        (candidate) =>
          candidate.evidenceId === row.evidenceId &&
          candidate.candidateRef === selection.candidateRef,
      ),
  );
  if (candidates.length !== 1)
    throw new Error("Image candidate is not bound to retained task evidence.");
  return candidates[0]!;
}
async function identifierSource(
  tx: DrizzleTransaction,
  operand: IdentifierOperand,
  manufacturer: string,
) {
  if (operand.kind === "gtin_14") return GTIN_SOURCE;
  if (operand.kind === "manufacturer_part") {
    const source = manufacturerSource(manufacturer);
    if (!source)
      throw new Error("Manufacturer part requires a canonical manufacturer.");
    return source;
  }
  return resolveProductIdentifierSource(tx, { url: operand.sourceURL });
}
async function commitIdentifier(
  tx: DrizzleTransaction,
  productId: typeof product.$inferSelect.id,
  manufacturer: string,
  operand: IdentifierOperand,
) {
  const source = await identifierSource(tx, operand, manufacturer);
  const externalId =
    operand.kind === "gtin_14"
      ? normalizeGtin(operand.externalId)
      : operand.externalId;
  if (!externalId) throw new Error("Identifier is not a valid GTIN.");
  try {
    const outcome = await learnPurchaseProductExternalId(tx, {
      productId,
      source,
      kind: operand.kind,
      externalId,
      url: operand.sourceURL,
    });
    const [row] = await tx
      .select()
      .from(entityExternalId)
      .where(
        and(
          eq(entityExternalId.entityKind, "product"),
          eq(entityExternalId.entityId, productId),
          eq(entityExternalId.source, source),
          eq(entityExternalId.kind, operand.kind),
          eq(entityExternalId.externalId, externalId),
          notDeleted(entityExternalId),
        ),
      );
    if (!row) throw new Error("Learned identifier has no live owned member.");
    return {
      changed: outcome === "learned",
      claim: {
        evidenceId: operand.evidenceId,
        fieldPath: researchMemberPath("externalIds", row.id),
        value: { source, kind: operand.kind, externalId },
        support: operand.support,
      } satisfies AcceptedResearchFact,
    };
  } catch (error) {
    if (!(error instanceof PurchaseProductExternalIdCollisionError))
      throw error;
    await upsertAgentProductMatch(tx, {
      productIds: [productId, error.ownerProductId],
      evidence: operand.support.reasoning,
      sourceUrls: [operand.sourceURL],
    });
    return null;
  }
}
async function readStoredImageBytes(key: string) {
  const response = await getS3Object(key);
  if (!response.ok) throw new Error(`Image read failed: ${response.status}`);
  return readResponseWithLimit(response, MAX_IMAGE_UPLOAD_BYTES);
}
async function prepareImage(
  db: Database,
  productId: string,
  selection: Proposal["imageCandidates"][number],
  observations: Observations,
  ports: ProductResearchPorts,
): Promise<PreparedImage> {
  const candidate = imageCandidate(selection, observations);
  const sourceUrl = candidate.highResolutionUrl ?? candidate.url;
  const [attached] = await getDb(db)
    .select({ row: image })
    .from(entityAttachment)
    .innerJoin(
      image,
      and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
    )
    .where(
      and(
        eq(entityAttachment.entityId, productId),
        eq(entityAttachment.entityKind, "product"),
        eq(image.sourceAssetUrl, sourceUrl),
        notDeleted(entityAttachment),
      ),
    );
  const imported = attached
    ? null
    : await (ports.importImage ?? importImageFromUrl)(db, {
        sourceUrl,
        filenamePrefix: "researched-product",
      });
  if (!attached && !imported)
    throw new Error("Representative image could not be imported.");
  const [loaded] = attached
    ? [attached.row]
    : await getDb(db)
        .select()
        .from(image)
        .where(and(eq(image.shortcode, imported!.imageId), notDeleted(image)));
  try {
    if (!loaded || loaded.sourceAssetUrl !== sourceUrl)
      throw new Error(
        "Representative image import does not match its retained source.",
      );
    if (!attached && loaded.source === "own")
      throw new Error(
        "An owned photo cannot be reassigned as a representative catalog image.",
      );
    const hash =
      loaded.sha256 ??
      (await sha256Hex(
        await (ports.readImageBytes ?? readStoredImageBytes)(loaded.key),
      ));
    return {
      row: loaded,
      hash,
      created: imported?.created ?? false,
      sourceUrl,
      evidenceIds: selection.evidenceIds,
      support: selection.support,
    };
  } catch (error) {
    if (loaded && imported?.created) {
      const removed = await withTransaction(db, (tx) =>
        reapUnreferencedImages(tx, [loaded.id]),
      );
      await (ports.deleteImageObjects ?? deleteStoredObjects)(
        removed.deletedKeys,
      );
    }
    throw error;
  }
}
async function provisionalCoverOrder(
  tx: DrizzleTransaction,
  productId: string,
  attachments: readonly (typeof entityAttachment.$inferSelect)[],
) {
  const first = attachments
    .filter((row) => row.purpose === "item")
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    )[0];
  if (!first || !isProvisionalOrderThumbnail(first.idempotencyKey, productId))
    return undefined;
  const [ownPhoto] = await tx
    .select({ id: image.id })
    .from(image)
    .where(
      and(
        inArray(
          image.id,
          attachments.map((row) => row.imageId),
        ),
        eq(image.source, "own"),
        notDeleted(image),
      ),
    )
    .limit(1);
  if (ownPhoto) return undefined;
  const [galleryIntent] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityKind, "product"),
        eq(auditLog.entityId, productId),
        gte(auditLog.createdAt, first.createdAt),
        or(
          sql`${auditLog.changes} ? 'imageOrder'`,
          sql`${auditLog.changes} ? 'images'`,
        ),
      ),
    )
    .limit(1);
  return galleryIntent ? undefined : first.sortOrder;
}

async function commitImage(
  tx: DrizzleTransaction,
  productId: string,
  prepared: PreparedImage,
) {
  const [live] = await tx
    .select()
    .from(image)
    .where(and(eq(image.id, prepared.row.id), notDeleted(image)))
    .for("update");
  if (
    !live ||
    live.key !== prepared.row.key ||
    live.sourceAssetUrl !== prepared.sourceUrl ||
    (live.sha256 && live.sha256 !== prepared.hash)
  )
    throw new Error("Representative image changed before commit.");
  if (!live.sha256)
    await tx
      .update(image)
      .set({ sha256: prepared.hash })
      .where(eq(image.id, live.id));
  const attachments = await tx
    .select()
    .from(entityAttachment)
    .where(
      and(
        eq(entityAttachment.entityKind, "product"),
        eq(entityAttachment.entityId, productId),
        notDeleted(entityAttachment),
      ),
    )
    .for("update");
  let member = attachments.find((row) => row.imageId === live.id);
  if (member?.purpose === "label")
    throw new Error(
      "A label image cannot become an item image through research.",
    );
  // The Product parent is locked before admission: a concurrent importer sees
  // the winner's attachment here. URL changes do not create another gallery
  // member, and reusing bytes preserves its original provenance and order.
  let representative = live;
  if (!member) {
    const [matching] = await tx
      .select({ attachment: entityAttachment, row: image })
      .from(entityAttachment)
      .innerJoin(image, eq(image.id, entityAttachment.imageId))
      .where(
        and(
          eq(entityAttachment.entityKind, "product"),
          eq(entityAttachment.entityId, productId),
          eq(entityAttachment.purpose, "item"),
          eq(image.sha256, prepared.hash),
          notDeleted(entityAttachment),
          notDeleted(image),
        ),
      )
      .orderBy(
        entityAttachment.sortOrder,
        entityAttachment.createdAt,
        entityAttachment.id,
      )
      .limit(1)
      .for("update");
    if (matching) {
      member = matching.attachment;
      representative = matching.row;
    }
  }
  const changed = !member;
  if (!member) {
    const promoteAt = await provisionalCoverOrder(tx, productId, attachments);
    const itemOrders = attachments
      .filter((row) => row.purpose === "item")
      .map((row) => row.sortOrder);
    if (promoteAt !== undefined)
      await tx
        .update(entityAttachment)
        .set({
          sortOrder: sql`${entityAttachment.sortOrder} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(entityAttachment.entityKind, "product"),
            eq(entityAttachment.entityId, productId),
            gte(entityAttachment.sortOrder, promoteAt),
            notDeleted(entityAttachment),
          ),
        );
    [member] = await tx
      .insert(entityAttachment)
      .values({
        entityKind: "product",
        entityId: productId,
        imageId: live.id,
        purpose: "item",
        sortOrder:
          promoteAt ?? (itemOrders.length ? Math.max(...itemOrders) + 1 : 0),
      })
      .returning();
  }
  if (!member) throw new Error("Representative image has no owned attachment.");
  const fieldPath = researchMemberPath("images", member.id);
  return {
    changed,
    claims: prepared.evidenceIds.map(
      (evidenceId) =>
        ({
          evidenceId,
          fieldPath,
          value: {
            imageId: representative.shortcode,
            sourceAssetUrl: representative.sourceAssetUrl,
            contentHash: prepared.hash,
          },
          support: prepared.support,
        }) satisfies AcceptedResearchFact,
    ),
  };
}
async function discardImages(
  db: Database,
  prepared: readonly PreparedImage[],
  deleteObjects: typeof deleteStoredObjects,
) {
  const ids = prepared.filter((row) => row.created).map((row) => row.row.id);
  if (!ids.length) return;
  const removed = await withTransaction(db, (tx) =>
    reapUnreferencedImages(tx, ids),
  );
  await deleteObjects(removed.deletedKeys);
}

function researchOutcome(
  proposal: Proposal,
  partial: boolean,
  acceptedClaimCount: number,
  completeCoverage: boolean,
) {
  if (partial && acceptedClaimCount) return "partially_verified" as const;
  if (
    ["verified", "partially_verified"].includes(proposal.status) &&
    !acceptedClaimCount
  )
    return "researched_with_gaps" as const;
  if (proposal.status === "verified" && !completeCoverage)
    return "researched_with_gaps" as const;
  return proposal.status;
}

function canCorrectProductAttempt(
  proposal: Proposal,
  coverage: {
    reviewRequired: boolean;
    refusals: number;
    accepted: number;
    operands: number;
    claims: number;
    completeCoverage: boolean;
  },
) {
  return (
    !coverage.reviewRequired &&
    ["verified", "partially_verified"].includes(proposal.status) &&
    (coverage.refusals > 0 ||
      coverage.accepted !== coverage.operands ||
      !coverage.claims ||
      (proposal.status === "verified" && !coverage.completeCoverage))
  );
}

async function recordProductAttempt(
  tx: DrizzleTransaction,
  input: {
    target: typeof runTarget.$inferSelect;
    proposal: Proposal;
    attempt: Awaited<ReturnType<typeof researchAttemptDisposition>>;
    productId: typeof product.$inferSelect.id;
    refusals: z.infer<typeof researchAssessment>["rejected"];
  },
) {
  const { target, proposal, attempt, productId, refusals } = input;
  const outcome = attempt.outcome;
  const refreshed = attempt.retry
    ? await productEnrichmentTarget(tx, productId)
    : undefined;
  if (attempt.retry && !refreshed)
    throw new Error("Research Product disappeared after accepted writes.");
  await tx
    .update(runTarget)
    .set({
      state: attempt.retry
        ? "needs_evidence"
        : outcome === "verified"
          ? "completed"
          : "unresolved",
      outcome: attempt.retry ? null : outcome,
      targetFingerprint: refreshed?.fingerprint ?? target.targetFingerprint,
      warning: [
        proposal.detail,
        ...refusals.map((refusal) => refusal.reason),
      ].join("\n"),
      completedAt: attempt.retry ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(runTarget.id, target.id));
}

/** Semantic acceptance precedes canonical fill-only writes and current member proofs. */
export async function resolveProductResearch(
  db: Database,
  input: { runId: string; callId: string; proposal: ResearchWorkResolveInput },
  ports: ProductResearchPorts = {},
) {
  const proposal = researchWorkResolve.parse(input.proposal);
  return executeAtomicOperation(
    db,
    {
      runId: runEntityId.parse(input.runId),
      operationId: input.callId,
      kind: "research_resolve_product",
      payload: proposal,
      subject: "Research resolution",
      recordFailure: true,
      retainAttempt: true,
    },
    async (ledger) => {
      const replayed = await ledger.replay(getDb(db), productResearchResult);
      if (replayed) return replayed;
      const { scope, target } = await assertResearchWork(
        db,
        input.runId,
        proposal.workRef,
      );
      if (
        target.entityKind !== "product" ||
        scope.purpose !== "product_enrichment"
      )
        throw new Error("Product research requires a Product task.");
      if (proposal.orders.length || proposal.emailLinks.length)
        throw new Error("A Product task cannot write purchase operands.");
      const productId = parseEntityId("product", target.entityId);
      const current = await productEnrichmentTarget(getDb(db), productId);
      if (!current || current.fingerprint !== target.targetFingerprint)
        throw new Error("Research Product changed since admission.");
      const observations = await loadResearchEvidence(
        db,
        {
          runId: input.runId,
          workRef: target.id,
          evidenceIds: [
            ...proposal.identity.evidenceIds,
            ...proposal.facts.map((fact) => fact.evidenceId),
            ...proposal.identifierClaims.map((claim) => claim.evidenceId),
            ...proposal.identifierCandidates.flatMap(
              (candidate) => candidate.evidenceIds,
            ),
            ...proposal.imageCandidates.flatMap(
              (candidate) => candidate.evidenceIds,
            ),
          ],
        },
        ports.readEvidence,
      );
      const orderedVariant = await loadProductPurchaseContext(db, {
        productId,
        ledgerPartyId: parseEntityId("ledgerParty", scope.ledgerPartyId!),
      });
      const assessmentInput = {
        context: {
          product: current.live,
          orderedVariant,
          referenceValues: await loadResearchReferenceContext(db, {
            entityKind: "product",
            facts: proposal.facts,
          }),
        },
        observations,
        proposal,
      };
      const assessed = researchAssessment.parse(
        ports.assess
          ? await ports.assess(assessmentInput)
          : await (
              await import("./research-support")
            ).assessResearchProposal({
              ...assessmentInput,
              db,
              runId: input.runId,
            }),
      );
      const operandCount =
        proposal.facts.length +
        proposal.identifierClaims.length +
        proposal.identifierCandidates.length +
        proposal.imageCandidates.length;
      const identitySupported =
        assessed.identityVerified && proposal.identity.evidenceIds.length > 0;
      // An unresolved report may contain declined claims. Preserve the report
      // without letting even an accepted family-level claim bypass exact identity.
      const supported = identitySupported
        ? assessed
        : {
            ...assessed,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedIdentifierClaims: [],
            acceptedImages: [],
          };
      const refusals = [...assessed.rejected];
      if (
        !identitySupported &&
        operandCount &&
        !refusals.some((item) => item.path === "identity")
      )
        refusals.push({
          path: "identity",
          reason:
            "Exact ordered variant identity was not supported; proposed facts were not accepted.",
        });
      const accepted = supported.acceptedFacts.map((index) => {
        const claim = operandAt(proposal.facts, index);
        return {
          ...claim,
          fieldPath: acceptedProductField.parse(claim.fieldPath),
        };
      });
      if (
        new Set(accepted.map((claim) => claim.fieldPath)).size !==
        accepted.length
      )
        throw new Error("A Product fact has competing accepted values.");
      const identifiers = [
        ...supported.acceptedIdentifierClaims.map((index) =>
          visibleIdentifier(
            operandAt(proposal.identifierClaims, index),
            observations,
          ),
        ),
        ...supported.acceptedIdentifiers.map((index) =>
          identifierCandidate(
            operandAt(proposal.identifierCandidates, index),
            observations,
          ),
        ),
      ];
      const prepared: PreparedImage[] = [];
      try {
        for (const index of supported.acceptedImages)
          prepared.push(
            await prepareImage(
              db,
              productId,
              operandAt(proposal.imageCandidates, index),
              observations,
              ports,
            ),
          );
        return await withTransaction(db, async (tx) => {
          await lockExternalIdentifierParents(tx, [
            { entityId: productId, entityKind: "product" },
          ]);
          const [lockedRun] = await tx
            .select()
            .from(run)
            .where(and(eq(run.id, scope.id), notDeleted(run)))
            .for("update");
          const recorded = await ledger.replay(tx, productResearchResult);
          if (recorded) return recorded;
          if (
            !lockedRun ||
            !["running", "paused_offline"].includes(lockedRun.status)
          )
            throw new Error("Research Run is no longer writable.");
          const [lockedTarget] = await tx
            .select()
            .from(runTarget)
            .where(
              and(eq(runTarget.id, target.id), eq(runTarget.runId, scope.id)),
            )
            .for("update");
          if (
            !lockedTarget ||
            !["pending", "prepared", "needs_evidence"].includes(
              lockedTarget.state,
            )
          )
            throw new Error("Research work is settled and closed.");
          const locked = await productEnrichmentTarget(tx, productId, {
            lock: true,
          });
          if (!locked || locked.fingerprint !== target.targetFingerprint)
            throw new Error("Research Product changed before commit.");
          await ledger.start(tx);
          const actor = actorInRun(
            buildActorContext(scope.actorUserId, scope.channel),
            scope.id,
          );
          const {
            changes,
            changedFields,
            claims,
            contradictions,
            refusals: domainRefusals,
          } = await commitAcceptedResearchFields(tx, {
            entityKind: "product",
            entityId: productId,
            live: locked.live,
            claims: accepted,
            actor,
            referenceAssessment: {
              facts: proposal.facts,
              values: assessmentInput.context.referenceValues,
            },
          });
          refusals.push(...domainRefusals);
          let refused = false;
          for (const operand of identifiers) {
            const committed = await commitIdentifier(
              tx,
              productId,
              changes.manufacturer ?? locked.live.manufacturer ?? "",
              operand,
            );
            if (!committed) {
              refused = true;
              continue;
            }
            if (committed.changed) changedFields.add("externalIds");
            claims.push(committed.claim);
          }
          for (const preparedImage of prepared) {
            const committed = await commitImage(tx, productId, preparedImage);
            if (committed.changed) changedFields.add("images");
            claims.push(...committed.claims);
          }
          const proof = await recordAcceptedFactEvidence(
            tx,
            { runId: scope.id, targetId: target.id, claims },
            readResearchCanonicalProjection,
          );
          const fieldCorrectionProof = await stageResearchFieldCorrections(tx, {
            scope,
            target,
            operationId: input.callId,
            attempt: proposal,
            assessment: supported,
            accepted,
            contradictions,
            observations,
            orderedVariant,
          });
          const relationWrites = [...changedFields].filter(
            (field) => field === "externalIds" || field === "images",
          );
          if (relationWrites.length)
            await recordRunWrites(
              tx,
              actorInRun(
                buildActorContext(scope.actorUserId, scope.channel),
                scope.id,
              ),
              [
                {
                  entityKind: "product",
                  entityId: productId,
                  action: "update",
                  fields: relationWrites,
                },
              ],
            );
          const acceptedCount =
            accepted.length + identifiers.length + prepared.length;
          const coverage = await loadProductResearchCoverage(tx, {
            productId,
            ledgerPartyId: parseEntityId("ledgerParty", scope.ledgerPartyId!),
          });
          const assessedOutcome = researchOutcome(
            proposal,
            Boolean(
              contradictions.length ||
              refused ||
              refusals.length ||
              acceptedCount !== operandCount,
            ),
            claims.length,
            coverage.complete,
          );
          const attempt = await researchAttemptDisposition(tx, {
            runId: scope.id,
            workRef: target.id,
            outcome: assessedOutcome,
            progress: changedFields.size + proof.inserted > 0,
            correctable: canCorrectProductAttempt(proposal, {
              reviewRequired: Boolean(contradictions.length || refused),
              refusals: refusals.length,
              accepted: acceptedCount,
              operands: operandCount,
              claims: claims.length,
              completeCoverage: coverage.complete,
            }),
            refusals,
          });
          const outcome = attempt.outcome;
          await recordProductAttempt(tx, {
            target,
            proposal,
            attempt,
            productId,
            refusals,
          });
          const result = productResearchResult.parse({
            outcome,
            changedFields: [...changedFields],
            verifiedFields: [
              ...new Set(claims.map((claim) => claim.fieldPath)),
            ],
            contradictions,
            refusals,
          });
          await ledger.complete(tx, {
            ...result,
            attempt: proposal,
            correctionAttempt: attempt.correctionAttempt,
            fieldCorrectionProof,
          });
          await afterProductResearchCommit(
            tx,
            {
              productId,
              runId: scope.id,
              changed: changedFields.size > 0,
              previousIngredientId: locked.live.ingredientId,
              ingredientId: changes.ingredientId,
            },
            ports,
          );
          return result;
        });
      } finally {
        await discardImages(
          db,
          prepared,
          ports.deleteImageObjects ?? deleteStoredObjects,
        );
      }
    },
  );
}
