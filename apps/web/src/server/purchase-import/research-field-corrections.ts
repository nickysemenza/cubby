import { actorInRun, type ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { researchFieldCorrection } from "@cubby/schemas/purchase-import";
import { acceptedResearchFact } from "@cubby/schemas/research";
import { researchAssessment } from "@cubby/schemas/research-assessment";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import {
  ledgerParty,
  run,
  runEvidence,
  runFinding,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  notDeleted,
} from "~/server/repo/database-helpers";
import { lockExternalIdentifierParents } from "~/server/repo/entity-external-ids";

import { canonicalJson, recordAcceptedFactEvidence } from "./fact-verification";
import { productEnrichmentTarget } from "./product-enrichment-target";
import {
  acceptedProductField,
  commitAcceptedResearchFields,
} from "./research-accepted-fields";
import { loadProductPurchaseContext } from "./research-context";
import {
  readRetainedResearchEvidence,
  type loadResearchEvidence,
} from "./research-evidence";
import { afterProductResearchCommit } from "./research-product-effects";
import { readResearchCanonicalProjection } from "./research-projection";

type Correction = z.infer<typeof researchFieldCorrection>;
type Observations = Awaited<ReturnType<typeof loadResearchEvidence>>;
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const fieldCorrectionProof = z.object({
  assessment: researchAssessment,
  attemptFingerprint: fingerprint,
  resolutionInputFingerprint: fingerprint,
  admissionFingerprint: fingerprint,
  identityTargetFingerprint: fingerprint,
  orderedVariantFingerprint: fingerprint,
  evidenceIds: z.array(z.uuid()).min(1),
});
const jsonFingerprint = (value: unknown) =>
  sha256Hex(canonicalJson(z.json().parse(value)));
const orderedVariantFingerprint = (
  context: Awaited<ReturnType<typeof loadProductPurchaseContext>>,
) =>
  jsonFingerprint(
    context.map((order) => canonicalJson(z.json().parse(order))).sort(),
  );

async function evidenceSnapshot(
  tx: DrizzleTransaction,
  input: {
    runId: typeof run.$inferSelect.id;
    targetId: string;
    evidenceIds: readonly string[];
  },
) {
  const rows = await tx
    .select()
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.runId, input.runId),
        eq(runEvidence.targetId, input.targetId),
        inArray(runEvidence.id, [...new Set(input.evidenceIds)]),
      ),
    )
    .for("share");
  if (rows.length !== new Set(input.evidenceIds).size)
    throw new Error(
      "Correction evidence no longer belongs to this exact task.",
    );
  const snapshot = rows
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      objectKey: row.objectKey,
      checksum: row.checksum,
      mediaType: row.mediaType,
      metadata: row.sourceMetadata,
    }));
  return { rows, fingerprint: await jsonFingerprint(snapshot) };
}

async function correctionFingerprint(fix: Correction) {
  const { fingerprint: _fingerprint, ...snapshot } = fix.reviewSnapshot;
  return jsonFingerprint({ ...fix, reviewSnapshot: snapshot });
}

/** The generic finding holds only host-accepted contradictions and retained task references. */
export async function stageResearchFieldCorrections(
  tx: DrizzleTransaction,
  input: {
    scope: typeof run.$inferSelect;
    target: typeof runTarget.$inferSelect;
    operationId: string;
    attempt: z.infer<typeof researchWorkResolve>;
    assessment: z.infer<typeof researchAssessment>;
    accepted: readonly z.infer<typeof acceptedResearchFact>[];
    contradictions: Awaited<
      ReturnType<typeof commitAcceptedResearchFields>
    >["contradictions"];
    observations: Observations;
    orderedVariant: Awaited<ReturnType<typeof loadProductPurchaseContext>>;
  },
) {
  if (!input.contradictions.length) return null;
  const productId = parseEntityId("product", input.target.entityId);
  const current = await productEnrichmentTarget(tx, productId, { lock: true });
  if (!current) throw new Error("Correction Product is no longer live.");
  const evidenceIds = input.observations.map((row) => row.evidenceId);
  const evidence = await evidenceSnapshot(tx, {
    runId: input.scope.id,
    targetId: input.target.id,
    evidenceIds,
  });
  for (const row of evidence.rows) {
    const observed = input.observations.find(
      (item) => item.evidenceId === row.id,
    );
    if (
      !observed ||
      row.checksum !== (await sha256Hex(observed.content)) ||
      canonicalJson(z.json().parse(row.sourceMetadata)) !==
        canonicalJson(z.json().parse(observed.metadata))
    )
      throw new Error("Correction evidence changed after semantic assessment.");
  }
  const corrections = input.contradictions.map((contradiction) => {
    const claim = input.accepted.find(
      (fact) => fact.fieldPath === contradiction.fieldPath,
    );
    if (
      !claim ||
      z.string().trim().parse(claim.value) !== contradiction.proposedValue
    )
      throw new Error("Correction is not an accepted source-supported fact.");
    return {
      currentValue: contradiction.currentValue,
      claim: { ...claim, value: contradiction.proposedValue },
    };
  });
  const fix = researchFieldCorrection.parse({
    kind: "research_field_correction",
    runRef: input.scope.shortcode,
    productId,
    targetId: input.target.id,
    resolutionOperationId: input.operationId,
    corrections,
    evidenceIds,
    reviewSnapshot: {
      fingerprint: "0".repeat(64),
      targetFingerprint: current.fingerprint,
      evidenceFingerprint: evidence.fingerprint,
    },
  });
  fix.reviewSnapshot.fingerprint = await correctionFingerprint(fix);
  await tx
    .insert(runFinding)
    .values({
      runId: input.scope.id,
      ledgerPartyId: parseEntityId("ledgerParty", input.scope.ledgerPartyId),
      entityKind: "product",
      entityId: productId,
      kind: "other",
      summary:
        "Supported source facts differ from this Product. Review the proposed corrections before replacing your saved values.",
      proposedFix: fix,
      evidenceFingerprint: fix.reviewSnapshot.fingerprint,
      autoApplied: false,
    })
    .onConflictDoNothing();
  return fieldCorrectionProof.parse({
    assessment: input.assessment,
    attemptFingerprint: await jsonFingerprint(input.attempt),
    resolutionInputFingerprint: await sha256Hex(JSON.stringify(input.attempt)),
    admissionFingerprint: await jsonFingerprint(input.scope.input),
    identityTargetFingerprint: input.target.targetFingerprint,
    orderedVariantFingerprint: await orderedVariantFingerprint(
      input.orderedVariant,
    ),
    evidenceIds,
  });
}

function assertAcceptedCorrections(
  fix: Correction,
  receipt: {
    attempt: z.infer<typeof researchWorkResolve>;
    fieldCorrectionProof: z.infer<typeof fieldCorrectionProof>;
  },
) {
  const { attempt, fieldCorrectionProof: proof } = receipt;
  if (
    !proof.assessment.identityVerified ||
    !attempt.identity.evidenceIds.length ||
    attempt.workRef !== fix.targetId
  )
    throw new Error("Correction has no accepted exact-variant identity.");
  const accepted = proof.assessment.acceptedFacts
    .map((index) => attempt.facts[index])
    .filter((fact) => fact !== undefined);
  for (const correction of fix.corrections) {
    acceptedProductField.parse(correction.claim.fieldPath);
    if (
      !accepted.some(
        (fact) =>
          canonicalJson(
            z
              .json()
              .parse({ ...fact, value: z.string().trim().parse(fact.value) }),
          ) === canonicalJson(z.json().parse(correction.claim)),
      )
    )
      throw new Error(
        "Correction changed from its accepted semantic assessment.",
      );
  }
  if (
    canonicalJson([...fix.evidenceIds].sort()) !==
    canonicalJson([...proof.evidenceIds].sort())
  )
    throw new Error("Correction retained evidence roster changed.");
}

type FindingScope = Pick<
  typeof runFinding.$inferSelect,
  "runId" | "ledgerPartyId" | "entityId"
>;

async function lockedCorrectionTask(
  tx: DrizzleTransaction,
  actor: ActorContext,
  runId: typeof run.$inferSelect.id,
  ledgerPartyId: typeof runFinding.$inferSelect.ledgerPartyId,
  fix: Correction,
) {
  const [owned] = await tx
    .select({ scope: run })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(run.id, runId),
        eq(run.actorUserId, actor.userId),
        eq(run.ledgerPartyId, ledgerPartyId),
        notDeleted(run),
      ),
    )
    .for("update", { of: run });
  const scope = owned?.scope;
  const [owner] = await tx
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.id, ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .for("share");
  const [target] = await tx
    .select()
    .from(runTarget)
    .where(
      and(
        eq(runTarget.id, fix.targetId),
        eq(runTarget.runId, runId),
        eq(runTarget.entityId, fix.productId),
        eq(runTarget.entityKind, "product"),
      ),
    )
    .for("update");
  if (
    !scope ||
    !owner ||
    !target ||
    scope.retiredAt ||
    scope.purpose !== "product_enrichment" ||
    scope.shortcode !== fix.runRef ||
    ["failed", "dispatch_failed"].includes(scope.status)
  )
    throw new Error("Correction task or member ownership changed.");
  return { scope, target };
}

async function acceptedCorrectionReceipt(
  tx: DrizzleTransaction,
  scope: typeof run.$inferSelect,
  target: typeof runTarget.$inferSelect,
  fix: Correction,
) {
  const [operation] = await tx
    .select()
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, scope.id),
        eq(runOperation.operationId, fix.resolutionOperationId),
        eq(runOperation.kind, "research_resolve_product"),
        eq(runOperation.state, "completed"),
      ),
    )
    .for("share");
  if (!operation)
    throw new Error("Correction accepted resolution is no longer available.");
  const receipt = z
    .object({ attempt: researchWorkResolve, fieldCorrectionProof })
    .parse(operation.result);
  if (
    (await jsonFingerprint(receipt.attempt)) !==
      receipt.fieldCorrectionProof.attemptFingerprint ||
    operation.inputFingerprint !==
      receipt.fieldCorrectionProof.resolutionInputFingerprint
  )
    throw new Error("Correction resolution snapshot changed.");
  assertAcceptedCorrections(fix, receipt);
  const admission = productResearchRunInput.parse(scope.input);
  const proof = receipt.fieldCorrectionProof;
  if (
    !admission.products.some((item) => item.productId === fix.productId) ||
    (await jsonFingerprint(scope.input)) !== proof.admissionFingerprint ||
    target.targetFingerprint !== proof.identityTargetFingerprint
  )
    throw new Error("Correction admitted identity or task snapshot changed.");
  return proof;
}

/** Member approval rechecks the sealed proposal, identity, bytes and live field values atomically. */
export async function applyResearchFieldCorrection(
  tx: DrizzleTransaction,
  actor: ActorContext,
  finding: FindingScope,
  fix: Correction,
  reviewedFingerprint?: string,
) {
  if (
    !finding.runId ||
    fix.productId !== finding.entityId ||
    reviewedFingerprint !== fix.reviewSnapshot.fingerprint ||
    (await correctionFingerprint(fix)) !== reviewedFingerprint
  )
    throw new Error(
      "Review the current Product correction snapshot before applying it.",
    );
  const productId = parseEntityId("product", fix.productId);
  await lockExternalIdentifierParents(tx, [
    { entityId: productId, entityKind: "product" },
  ]);
  const { scope, target } = await lockedCorrectionTask(
    tx,
    actor,
    parseEntityId("run", finding.runId),
    finding.ledgerPartyId,
    fix,
  );
  const proof = await acceptedCorrectionReceipt(tx, scope, target, fix);
  const current = await productEnrichmentTarget(tx, productId, { lock: true });
  if (!current || current.fingerprint !== fix.reviewSnapshot.targetFingerprint)
    throw new Error("Product changed after the correction was reviewed.");
  const orderedVariant = await loadProductPurchaseContext(
    databaseForTransaction(tx),
    {
      productId,
      ledgerPartyId: finding.ledgerPartyId,
    },
  );
  if (
    (await orderedVariantFingerprint(orderedVariant)) !==
    proof.orderedVariantFingerprint
  )
    throw new Error("Correction ordered-variant context changed.");
  const evidence = await evidenceSnapshot(tx, {
    runId: scope.id,
    targetId: target.id,
    evidenceIds: fix.evidenceIds,
  });
  if (evidence.fingerprint !== fix.reviewSnapshot.evidenceFingerprint)
    throw new Error("Correction retained source snapshot changed.");
  for (const row of evidence.rows) {
    const content = await readRetainedResearchEvidence(row);
    if ((await sha256Hex(content)) !== row.checksum)
      throw new Error("Correction retained evidence checksum changed.");
  }
  const result = await commitAcceptedResearchFields(tx, {
    entityKind: "product",
    entityId: productId,
    live: current.live,
    claims: fix.corrections.map((correction) => correction.claim),
    reviewedCurrentValues: new Map(
      fix.corrections.map((correction) => [
        correction.claim.fieldPath,
        correction.currentValue,
      ]),
    ),
    actor: actorInRun(actor, scope.id),
  });
  if (
    result.contradictions.length ||
    result.refusals.length ||
    result.claims.length !== fix.corrections.length
  )
    throw new Error(
      `Product correction was refused by the current domain policy: ${result.refusals.map((item) => item.reason).join("; ")}`,
    );
  await recordAcceptedFactEvidence(
    tx,
    {
      runId: scope.id,
      targetId: target.id,
      claims: result.claims,
    },
    readResearchCanonicalProjection,
  );
  await afterProductResearchCommit(
    tx,
    {
      productId,
      runId: scope.id,
      changed: result.changedFields.size > 0,
      previousIngredientId: current.live.ingredientId,
      ingredientId: result.changes.ingredientId,
    },
    {},
  );
  return result;
}
