import {
  assessmentReviewInput,
  assessmentSubjects,
} from "@cubby/schemas/assessment";
import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionAssessmentEvidence,
  connectionCandidate,
  connectionProposal,
  type ConnectionCandidate,
  type ConnectionProposal,
} from "@cubby/schemas/entity-connections";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  entityIdentity,
  feedback,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { updateFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { acceptFinancialTransferPair } from "~/server/domains/financial-transaction/repo/financial-transfer-accept";
import { moveInventoryEntries } from "~/server/domains/inventory/repo/bulk";
import { setProjectToolUsage } from "~/server/domains/project/repo/tools";
import { confirmPurchaseAcquisition } from "~/server/domains/purchase/repo/purchase-products";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { assessmentCandidateKey } from "~/server/generic/assessment/repo/assessment-state";
import {
  lookupEntityLabels,
  resolveShortcodes,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { canonicalJson } from "~/server/lib/canonical-json";

import {
  acquisitionPairEligible,
  expenseConnectionEligible,
} from "./connection-candidates";
import {
  captureConnectionBasis,
  prepareConnectionBases,
} from "./connection-evidence";
import { applyEmailConnection } from "./email-connections";
import { readExistingConnectionAssessments } from "./existing-assessments";

const sourceKey = (ref: EntityRef) => `${ref.entityKind}:${ref.entityId}`;
const scopeFor = (candidate: ConnectionCandidate) =>
  `connection.${candidate.relation}`;
const keyFor = (candidate: ConnectionCandidate) =>
  assessmentCandidateKey(scopeFor(candidate), [
    sourceKey(candidate.source),
    sourceKey(candidate.target),
  ]);

/** Capture candidate evidence before later inference; no proposal is published here. */
export async function prepareEntityConnection(
  db: Database,
  raw: ConnectionCandidate,
) {
  const candidate = connectionCandidate.parse(raw);
  const prepared = connectionAssessmentEvidence.parse({
    version: 1,
    candidate,
    basis: await captureConnectionBasis(db, candidate),
  });
  await assertAcquisitionConnectionEligible(db, candidate);
  return (transactionDb: Database) =>
    publishPreparedEntityConnection(transactionDb, prepared);
}

/** Immediate callers still capture their basis before entering publication locks. */
export async function publishEntityConnection(
  db: Database,
  raw: ConnectionCandidate,
): Promise<ConnectionProposal> {
  const publish = await prepareEntityConnection(db, raw);
  return publish(db);
}

async function publishPreparedEntityConnection(
  db: Database,
  prepared: z.infer<typeof connectionAssessmentEvidence>,
): Promise<ConnectionProposal> {
  const { candidate } = prepared;
  return withTransactionDatabase(db, async (db) => {
    const basis = await captureConnectionBasis(db, candidate, true);
    if (canonicalJson(basis) !== canonicalJson(prepared.basis))
      throw new Error(
        "Connection evidence changed after candidate retrieval; discover again before publishing",
      );
    await assertAcquisitionConnectionEligible(db, candidate);
    if (
      candidate.relation === "email-purchase" &&
      !z
        .object({ dependencies: z.object({ eventId: z.string() }) })
        .safeParse(basis).success
    )
      throw new Error(
        "Retained Email evidence changed; discover again before publishing",
      );
    const evidence = connectionAssessmentEvidence.parse({
      version: 1,
      candidate,
      basis,
    });
    const fingerprint = await sha256Hex(canonicalJson(evidence));
    const candidateKey = await keyFor(candidate);
    const scope = scopeFor(candidate);
    const entity = z.enum(shortcodeEntities).parse(candidate.source.entityKind);
    const recordId = await resolveOrThrow(
      db,
      entity,
      candidate.source.entityId,
    );
    const prediction = await publishAssessment(
      db,
      {
        publicationKey: `connection:${recordId}:${candidateKey}:${fingerprint}`,
        family: "recommendation",
        subject: {
          kind: "recommendation",
          entity,
          recordId,
          scope,
          candidateKey,
        },
        judgment: { candidateKey },
        fingerprint,
        producer: null,
        evidence,
      },
      { data: { connection: true } },
    );
    await getDb(db)
      .update(assessmentState)
      .set({ active: false, status: "superseded" })
      .where(
        and(
          eq(assessmentState.family, "recommendation"),
          eq(assessmentState.entity, entity),
          eq(assessmentState.recordId, recordId),
          eq(assessmentState.active, true),
          sql`${assessmentState.suppression} IS NULL`,
          sql`${assessmentState.id} <> ${prediction.id}`,
          sql`${assessmentState.id} IN (SELECT prior.id FROM "Assessment" prior WHERE prior.subject->>'scope'=${scope} AND prior.subject->>'candidateKey'=${candidateKey})`,
        ),
      );
    return connectionProposal.parse({
      ...candidate,
      fingerprint,
      review: {
        assessmentId: prediction.id,
        suppression: { scope, candidateKey, fingerprint: null },
      },
      integration: { kind: "connection-review" },
    });
  });
}

/** Batched Assessment selection; freshness also rereads family-owned evidence. */
export async function readEntityConnectionsBatch(
  db: Database,
  raw: readonly EntityRef[],
): Promise<ConnectionProposal[][]> {
  const sources = z.array(entityGraphRootSchema).max(250).parse(raw);
  if (!sources.length) return [];
  const keys = sources.map(sourceKey);
  const rows = await getDb(db)
    .select({ prediction: assessment })
    .from(assessment)
    .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .where(
      and(
        eq(assessment.family, "recommendation"),
        eq(assessment.served, true),
        eq(assessmentState.active, true),
        eq(assessmentState.status, "pending"),
        sql`${assessment.subject}->>'scope' LIKE 'connection.%'`,
        sql`(${inArray(sql`(${assessment.evidence}->'candidate'->${"source"}->>'entityKind') || ':' || (${assessment.evidence}->'candidate'->${"source"}->>'entityId')`, keys)} OR ${inArray(sql`(${assessment.evidence}->'candidate'->${"target"}->>'entityKind') || ':' || (${assessment.evidence}->'candidate'->${"target"}->>'entityId')`, keys)})`,
        notExists(
          getDb(db)
            .select({ id: feedback.id })
            .from(feedback)
            .where(
              and(
                eq(feedback.assessmentId, assessment.id),
                eq(feedback.authority, "member"),
                inArray(feedback.verdict, ["wrong", "dismissed"]),
              ),
            ),
        ),
        sql`NOT EXISTS (SELECT 1 FROM "AssessmentState" suppressed WHERE suppressed.active AND suppressed.entity=${assessmentState.entity} AND suppressed."recordId"=${assessmentState.recordId} AND suppressed.suppression->>'scope'=${assessment.subject}->>'scope' AND suppressed.suppression->>'candidateKey'=${assessment.subject}->>'candidateKey' AND (suppressed.suppression->>'fingerprint' IS NULL OR suppressed.suppression->>'fingerprint'=${assessment.fingerprint}))`,
      ),
    )
    .orderBy(assessment.createdAt, assessment.id);
  const parsed = rows.flatMap(({ prediction }) => {
    const evidence = connectionAssessmentEvidence.safeParse(
      prediction.evidence,
    );
    const subject = assessmentSubjects.recommendation.safeParse(
      prediction.subject,
    );
    if (!evidence.success || !subject.success || !prediction.fingerprint)
      return [];
    return [
      connectionProposal.parse({
        ...evidence.data.candidate,
        fingerprint: prediction.fingerprint,
        review: {
          assessmentId: prediction.id,
          suppression: {
            scope: subject.data.scope,
            candidateKey: subject.data.candidateKey,
            fingerprint: null,
          },
        },
        integration: { kind: "connection-review" },
      }),
    ];
  });
  const endpointCodes = [
    ...new Set(parsed.flatMap((p) => [p.source.entityId, p.target.entityId])),
  ];
  const live = endpointCodes.length
    ? await getDb(db)
        .select({ code: entityIdentity.shortcode, kind: entityIdentity.kind })
        .from(entityIdentity)
        .where(
          and(
            inArray(entityIdentity.shortcode, endpointCodes),
            sql`${entityIdentity.deletedAt} IS NULL`,
            sql`${entityIdentity.mergedIntoId} IS NULL`,
          ),
        )
    : [];
  const liveKeys = new Set(live.map((row) => `${row.kind}:${row.code}`));
  const fresh: ConnectionProposal[] = [];
  const liveProposals = parsed.filter(
    (proposal) =>
      liveKeys.has(sourceKey(proposal.source)) &&
      liveKeys.has(sourceKey(proposal.target)),
  );
  const prepared = await prepareConnectionBases(db, liveProposals);
  for (const proposal of liveProposals) {
    const basis = await captureConnectionBasis(db, proposal, false, prepared);
    if (
      (await sha256Hex(
        canonicalJson({
          version: 1,
          candidate: connectionCandidate.parse(proposal),
          basis,
        }),
      )) === proposal.fingerprint
    )
      fresh.push(proposal);
  }
  const existing = await readExistingConnectionAssessments(db, sources);
  const grouped = sources.map((source, index) => [
    ...fresh.filter(
      (p) =>
        liveKeys.has(sourceKey(p.source)) &&
        liveKeys.has(sourceKey(p.target)) &&
        (sourceKey(p.source) === sourceKey(source) ||
          sourceKey(p.target) === sourceKey(source)),
    ),
    ...(existing[index] ?? []),
  ]);
  const unique = grouped.map((proposals) => [
    ...new Map(
      proposals.map((proposal) => [
        `${proposal.relation}:${sourceKey(proposal.source)}:${sourceKey(proposal.target)}`,
        proposal,
      ]),
    ).values(),
  ]);
  const refs = await resolveShortcodes(db, [
    ...new Set(
      unique.flat().flatMap((p) => [p.source.entityId, p.target.entityId]),
    ),
  ]);
  const names = await lookupEntityLabels(db, [...refs.values()]);
  return unique.map((proposals) =>
    proposals.map((proposal) => {
      const sourceRef = refs.get(proposal.source.entityId),
        targetRef = refs.get(proposal.target.entityId);
      return {
        ...proposal,
        sourceName: sourceRef
          ? names.get(`${sourceRef.entity}:${sourceRef.id}`)
          : undefined,
        targetName: targetRef
          ? names.get(`${targetRef.entity}:${targetRef.id}`)
          : undefined,
      };
    }),
  );
}

/** Stored-only, including inverse endpoint lookup; never calls discovery or models. */
export async function readEntityConnections(
  db: Database,
  source: EntityRef,
): Promise<ConnectionProposal[]> {
  return (await readEntityConnectionsBatch(db, [source]))[0] ?? [];
}

type ApplyInput = Pick<
  z.infer<typeof assessmentReviewInput>,
  "verdict" | "expectedFingerprint" | "correction"
>;
/** Called only by reviewAssessment, which owns the atomic application receipt. */
export async function applyEntityConnection(
  db: Database,
  context: EntityKernelContext,
  state: { id: string },
  input: ApplyInput,
): Promise<{ source: EntityRef; destination: EntityRef } | void> {
  if (input.verdict !== "correct" || input.correction.present)
    throw new Error(
      "Connection application requires acceptance of its exact proposal",
    );
  return withTransactionDatabase(db, async (db) => {
    const [prediction] = await getDb(db)
      .select()
      .from(assessment)
      .where(eq(assessment.id, state.id))
      .limit(1);
    if (!prediction || prediction.family !== "recommendation")
      throw new Error("Connection Assessment not found");
    const subject = assessmentSubjects.recommendation.parse(prediction.subject);
    const evidence = connectionAssessmentEvidence.parse(prediction.evidence);
    const { candidate } = evidence;
    if (
      subject.scope !== scopeFor(candidate) ||
      subject.candidateKey !== (await keyFor(candidate)) ||
      subject.entity !== candidate.source.entityKind ||
      subject.recordId !==
        (await resolveOrThrow(
          db,
          z.enum(shortcodeEntities).parse(candidate.source.entityKind),
          candidate.source.entityId,
        ))
    )
      throw new Error(
        "Connection Assessment does not match its declared endpoints",
      );
    const basis = await captureConnectionBasis(db, candidate, true);
    const [freshState] = await getDb(db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, state.id))
      .limit(1)
      .for("update");
    if (!freshState?.active || freshState.status !== "pending")
      throw new Error("Connection Assessment is no longer pending");
    if (
      !input.expectedFingerprint ||
      input.expectedFingerprint !== prediction.fingerprint ||
      (await sha256Hex(canonicalJson({ ...evidence, basis }))) !==
        prediction.fingerprint
    )
      throw new Error(
        "Connection evidence changed; discover again before applying",
      );
    await assertAcquisitionConnectionEligible(db, candidate);
    const actor = context.actorContext;
    switch (candidate.relation) {
      case "email-purchase":
        await applyEmailConnection(db, candidate, basis, actor);
        break;
      case "product-purchase":
        await confirmPurchaseAcquisition(db, {
          purchaseId: parseShortcodeFor("purchase", candidate.target.entityId),
          productId: parseShortcodeFor("product", candidate.source.entityId),
        });
        break;
      case "product-expense":
        await updateExpense(
          db,
          parseShortcodeFor("expense", candidate.target.entityId),
          {
            productId: parseShortcodeFor("product", candidate.source.entityId),
          },
          actor,
        );
        break;
      case "expense-project":
        await updateExpense(
          db,
          parseShortcodeFor("expense", candidate.source.entityId),
          {
            projectId: parseShortcodeFor("project", candidate.target.entityId),
          },
          actor,
        );
        break;
      case "project-tool":
        await setProjectToolUsage(
          db,
          await resolveOrThrow(db, "project", candidate.source.entityId),
          await resolveOrThrow(db, "product", candidate.target.entityId),
          true,
          actor,
        );
        break;
      case "transaction-purchase":
      case "transaction-refund": {
        const transactionId = await resolveOrThrow(
          db,
          "financialTransaction",
          candidate.source.entityId,
        );
        const [allocation] = await getDb(db)
          .select({ id: financialTransactionAllocation.id })
          .from(financialTransactionAllocation)
          .where(
            and(
              eq(financialTransactionAllocation.transactionId, transactionId),
              sql`${financialTransactionAllocation.deletedAt} IS NULL`,
            ),
          )
          .limit(1);
        if (allocation)
          throw new Error(
            "Connection confirmation cannot replace existing financial allocations; use the allocation editor",
          );
        await updateFinancialTransaction(
          db,
          parseShortcodeFor("financialTransaction", candidate.source.entityId),
          {
            purchaseId: parseShortcodeFor(
              "purchase",
              candidate.target.entityId,
            ),
          },
          actor,
        );
        break;
      }
      case "transaction-transfer": {
        const basisRows = z
          .object({
            source: z.object({ amount: z.coerce.number() }),
            target: z.object({ amount: z.coerce.number() }),
          })
          .parse(basis);
        const outflow =
          basisRows.source.amount > 0 ? candidate.source : candidate.target;
        const inflow =
          basisRows.source.amount > 0 ? candidate.target : candidate.source;
        const result = await acceptFinancialTransferPair(
          db,
          {
            outflowTransactionId: parseShortcodeFor(
              "financialTransaction",
              outflow.entityId,
            ),
            inflowTransactionId: parseShortcodeFor(
              "financialTransaction",
              inflow.entityId,
            ),
          },
          actor,
        );
        if (!result.canProceed) throw new Error(result.reason);
        break;
      }
      case "inventory-location": {
        const moved = await moveInventoryEntries(
          db,
          {
            items: [
              {
                inventoryEntryId: await resolveOrThrow(
                  db,
                  "inventory",
                  candidate.source.entityId,
                ),
                targetLocationId: await resolveOrThrow(
                  db,
                  "location",
                  candidate.target.entityId,
                ),
              },
            ],
          },
          actor,
        );
        const survivor = moved[0];
        if (!survivor)
          throw new Error(
            "Inventory connection move returned no surviving destination",
          );
        return {
          source: candidate.source,
          destination: { entityKind: "inventory", entityId: survivor.id },
        };
      }
      default:
        throw new Error(
          `Connection ${candidate.relation} requires its existing family Assessment action`,
        );
    }
  });
}

/** A matching snapshot never authorizes replacing an existing acquisition decision. */
async function assertAcquisitionConnectionEligible(
  db: Database,
  candidate: ConnectionCandidate,
): Promise<void> {
  if (
    candidate.relation === "product-expense" &&
    !(await expenseConnectionEligible(db, candidate.target.entityId))
  )
    throw new Error(
      "Connection Expense is no longer eligible for acquisition or is already assigned to a Product",
    );
  if (
    candidate.relation === "product-purchase" &&
    !(await acquisitionPairEligible(
      db,
      candidate.source.entityId,
      candidate.target.entityId,
    ))
  )
    throw new Error(
      "Connection Product/Purchase pair is no longer eligible because acquisition is already recorded",
    );
}
