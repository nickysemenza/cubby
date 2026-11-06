import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionSuggestionEvidence,
  connectionCandidate,
  connectionEdgeKey as edgeKey,
  connectionProposal,
  type ConnectionCandidate,
  type ConnectionProposal,
} from "@cubby/schemas/entity-connections";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  suggestionReviewInput,
  suggestionSubjects,
} from "@cubby/schemas/suggestion";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  uuidArrayParam,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  suggestionTable,
  entityIdentity,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { updateFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { moveInventoryEntries } from "~/server/domains/inventory/repo/bulk";
import { setProjectToolUsage } from "~/server/domains/project/repo/tools";
import { confirmPurchaseAcquisition } from "~/server/domains/purchase/repo/purchase-products";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  lookupEntityLabels,
  resolveShortcodes,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { publishSuggestions } from "~/server/generic/suggestions/repo/suggestion";
import { memberRejectedSql } from "~/server/generic/suggestions/repo/suggestion-decisions";
import {
  suggestionStateColumns,
  pruneReplacedSuggestions,
  transitionSuggestionStates,
} from "~/server/generic/suggestions/repo/suggestion-state";
import { suggestionCandidateKey } from "~/server/generic/suggestions/repo/suggestion-state";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "~/server/lib/canonical-json";

import {
  acquisitionPairKey,
  eligibleAcquisitionPairs,
  eligibleConnectionExpenses,
} from "./connection-candidates";
import {
  captureConnectionBasis,
  captureConnectionEvidence,
  connectionReadEvidence,
  connectionReadEvidenceSql,
  forEachConnectionBasis,
  prepareConnectionBases,
} from "./connection-evidence";
import { applyEmailConnection } from "./email-connections";
import {
  readExistingConnectionSuggestions,
  readSelectedConnectionSuggestionIds,
} from "./existing-suggestions";

const sourceKey = (ref: EntityRef) => `${ref.entityKind}:${ref.entityId}`;
const scopeFor = (candidate: ConnectionCandidate) =>
  `connection.${candidate.relation}`;
const keyFor = (candidate: ConnectionCandidate) =>
  suggestionCandidateKey(scopeFor(candidate), [
    sourceKey(candidate.source),
    sourceKey(candidate.target),
  ]);

/** Fresh retrieval may be retried; it must never exhaust an execution attempt. */
export class ConnectionEvidenceInvalidatedError extends Error {}

export type PreparedEntityConnection = z.infer<
  typeof connectionSuggestionEvidence
>;

/** Capture immutable retrieval evidence before any subsequent provider wait. */
export async function prepareEntityConnectionEvidence(
  db: Database,
  raws: readonly ConnectionCandidate[],
  expenseProjects?: Parameters<typeof prepareConnectionBases>[2],
): Promise<PreparedEntityConnection[]> {
  const candidates = raws.map((raw) => connectionCandidate.parse(raw));
  const prepared: PreparedEntityConnection[] = [];
  await forEachConnectionBasis(
    db,
    candidates.map((candidate) => ({ candidate })),
    async ({ candidate }, basis) => {
      // Both children are validated already; retain the capture's frozen shared JSON.
      prepared.push({ version: 1, candidate, basis });
    },
    expenseProjects,
  );
  await assertAcquisitionConnectionsEligible(db, candidates);
  return prepared;
}

/** Immediate callers still capture their basis before entering publication locks. */
export async function publishEntityConnection(
  db: Database,
  raw: ConnectionCandidate,
): Promise<ConnectionProposal> {
  const prepared = await prepareEntityConnectionEvidence(db, [raw]);
  const [proposal] = await publishPreparedEntityConnections(db, prepared);
  return proposal!;
}

/** Locked evidence, eligibility, immutable publications and supersession share a chunk. */
export async function publishPreparedEntityConnections(
  db: Database,
  prepared: readonly PreparedEntityConnection[],
): Promise<ConnectionProposal[]> {
  if (!prepared.length) return [];
  return withTransactionDatabase(db, async (db) => {
    const candidates = prepared.map((entry) => entry.candidate);
    // Capture again under endpoint locks. Never reuse the unlocked retrieval basis.
    const locked = await prepareConnectionBases(
      db,
      candidates,
      undefined,
      true,
    );
    await assertAcquisitionConnectionsEligible(db, candidates);
    const entries = [];
    for (const original of prepared) {
      const { candidate } = original;
      const { basis, sourceId } = await captureConnectionEvidence(
        db,
        candidate,
        true,
        locked,
      );
      if (canonicalJson(basis) !== canonicalJson(original.basis))
        throw new ConnectionEvidenceInvalidatedError(
          "Connection evidence changed after candidate retrieval; discover again before publishing",
        );
      if (
        candidate.relation === "email-purchase" &&
        !z
          .object({ dependencies: z.object({ eventId: z.string() }) })
          .safeParse(basis).success
      )
        throw new ConnectionEvidenceInvalidatedError(
          "Retained Email evidence changed; discover again before publishing",
        );
      const fingerprint = await sha256CanonicalJson(
        connectionSuggestionEvidence.parse({ version: 1, candidate, basis }),
      );
      // Review hashes the current basis against this fingerprint, so the basis
      // itself is not kept: it averaged 200 kB a row.
      const evidence = { version: 1, candidate };
      const candidateKey = await keyFor(candidate);
      const scope = scopeFor(candidate);
      const entity = z
        .enum(shortcodeEntities)
        .parse(candidate.source.entityKind);
      const recordId =
        sourceId ??
        (await resolveOrThrow(db, entity, candidate.source.entityId));
      entries.push({
        candidate,
        fingerprint,
        candidateKey,
        scope,
        entity,
        recordId,
        evidence,
      });
    }
    const predictions = await publishSuggestions(
      db,
      entries.map((entry) => ({
        input: {
          publicationKey: `connection:${entry.recordId}:${entry.candidateKey}:${entry.fingerprint}`,
          family: "recommendation",
          subject: {
            kind: "recommendation",
            entity: entry.entity,
            recordId: entry.recordId,
            scope: entry.scope,
            candidateKey: entry.candidateKey,
          },
          judgment: { candidateKey: entry.candidateKey },
          fingerprint: entry.fingerprint,
          producer: null,
          evidence: entry.evidence,
        },
        // Queue counts need only this reference, not the full immutable basis.
        projection: {
          data: { connection: true, connectionTarget: entry.candidate.target },
        },
      })),
    );
    // Several page owners may retrieve the same edge. Sequential publication
    // leaves the last fingerprint active; the set write must do the same.
    const latest = new Map(
      entries.map((entry, index) => [
        `${entry.entity}:${entry.recordId}:${entry.scope}:${entry.candidateKey}`,
        { entry, index },
      ]),
    );
    const slots = [...latest.values()];
    const wanted = sql.join(
      slots.map(
        ({ entry, index }) =>
          sql`(${entry.entity}::text, ${entry.recordId}::uuid, ${entry.scope}::text, ${entry.candidateKey}::text, ${predictions[index]!.id}::uuid)`,
      ),
      sql`, `,
    );
    const replaced = await transitionSuggestionStates(
      db,
      and(
        eq(suggestionTable.family, "recommendation"),
        eq(suggestionTable.active, true),
        sql`${suggestionTable.suppression} IS NULL`,
        inArray(suggestionTable.entity, [
          ...new Set(entries.map((entry) => entry.entity)),
        ]),
        inArray(suggestionTable.recordId, [
          ...new Set(entries.map((entry) => entry.recordId)),
        ]),
        // Scope the indexed live subjects first, then join immutable evidence
        // once. An OR of per-slot Suggestion subqueries replans/scans history
        // for every candidate and dominated production-copy publication time.
        sql`EXISTS (
          SELECT 1 FROM (VALUES ${wanted}) wanted(entity, record_id, scope, candidate_key, current_id)
          JOIN "Suggestion" prior ON prior.id = ${suggestionTable.id}
          WHERE wanted.entity = ${suggestionTable.entity}
            AND wanted.record_id = ${suggestionTable.recordId}
            AND prior.id <> wanted.current_id
            AND prior.subject->>'scope' = wanted.scope
            AND prior.subject->>'candidateKey' = wanted.candidate_key
        )`,
      ),
      { active: false, status: "superseded" },
    );
    await pruneReplacedSuggestions(
      db,
      replaced.map((row) => row.id),
    );
    return entries.map((entry, index) =>
      connectionProposal.parse({
        ...entry.candidate,
        fingerprint: entry.fingerprint,
        review: {
          suggestionId: predictions[index]!.id,
          suppression: {
            scope: entry.scope,
            candidateKey: entry.candidateKey,
            fingerprint: null,
          },
        },
        integration: { kind: "connection-review" },
      }),
    );
  });
}

const connectionReadSelection = {
  id: suggestionTable.id,
  family: suggestionTable.family,
  subject: suggestionTable.subject,
  fingerprint: suggestionTable.fingerprint,
  // Freshness hashes the current basis, so the retained snapshot stays in SQL.
  evidence: connectionReadEvidenceSql(sql`${suggestionTable.evidence}`),
};

function storedConnectionProposal(prediction: {
  id: string;
  subject: unknown;
  fingerprint: string | null;
  evidence: unknown;
}) {
  const evidence = connectionReadEvidence.safeParse(prediction.evidence);
  const subject = suggestionSubjects.recommendation.safeParse(
    prediction.subject,
  );
  if (!evidence.success || !subject.success || !prediction.fingerprint)
    return [];
  return [
    connectionProposal.parse({
      ...evidence.data.candidate,
      fingerprint: prediction.fingerprint,
      review: {
        suggestionId: prediction.id,
        suppression: {
          scope: subject.data.scope,
          candidateKey: subject.data.candidateKey,
          fingerprint: null,
        },
      },
      integration: { kind: "connection-review" },
    }),
  ];
}

/** Batched Suggestion selection; freshness also rereads family-owned evidence. */
async function readEntityConnectionsBatch(
  db: Database,
  raw: readonly EntityRef[],
  reviewIds?: readonly string[],
  observeBasis?: (
    id: string,
    candidate: ConnectionCandidate,
    basis: z.infer<typeof connectionSuggestionEvidence>["basis"],
  ) => void,
): Promise<ConnectionProposal[][]> {
  const sources = z.array(entityGraphRootSchema).max(250).parse(raw);
  if (!sources.length) return [];
  const keys = sources.map(sourceKey);
  let selectedEdgeIds: string[] | undefined;
  if (reviewIds) {
    if (!reviewIds.length) return sources.map(() => []);
    selectedEdgeIds = await readSelectedConnectionSuggestionIds(db, reviewIds);
    if (!selectedEdgeIds.length) return sources.map(() => []);
  }
  const rows = await getDb(db)
    .select({
      prediction: connectionReadSelection,
    })
    .from(suggestionTable)
    .where(
      and(
        eq(suggestionTable.family, "recommendation"),

        eq(suggestionTable.active, true),
        eq(suggestionTable.status, "pending"),
        sql`${suggestionTable.subject}->>'scope' LIKE 'connection.%'`,
        // Retain every competitor on a selected edge: filtering by review ID
        // alone could resurrect a proposal replaced by the reader's deduplication.
        selectedEdgeIds
          ? sql`${suggestionTable.id} = ANY(${uuidArrayParam(selectedEdgeIds)})`
          : undefined,
        sql`(${inArray(sql`(${suggestionTable.evidence}->'candidate'->${"source"}->>'entityKind') || ':' || (${suggestionTable.evidence}->'candidate'->${"source"}->>'entityId')`, keys)} OR ${inArray(sql`(${suggestionTable.evidence}->'candidate'->${"target"}->>'entityKind') || ':' || (${suggestionTable.evidence}->'candidate'->${"target"}->>'entityId')`, keys)})`,
        sql`NOT ${memberRejectedSql(sql`${suggestionTable.decisions}`)}`,
        sql`NOT EXISTS (SELECT 1 FROM "Suggestion" suppressed WHERE suppressed.active AND suppressed.entity=${suggestionTable.entity} AND suppressed."recordId"=${suggestionTable.recordId} AND suppressed.suppression->>'scope'=${suggestionTable.subject}->>'scope' AND suppressed.suppression->>'candidateKey'=${suggestionTable.subject}->>'candidateKey' AND (suppressed.suppression->>'fingerprint' IS NULL OR suppressed.suppression->>'fingerprint'=${suggestionTable.fingerprint}))`,
      ),
    )
    .orderBy(suggestionTable.createdAt, suggestionTable.id);
  const parsed = rows.flatMap(({ prediction }) =>
    storedConnectionProposal(prediction),
  );
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
  const liveProposals = parsed.filter(
    (proposal) =>
      liveKeys.has(sourceKey(proposal.source)) &&
      liveKeys.has(sourceKey(proposal.target)),
  );
  const selectedExisting = selectedEdgeIds
    ? await readExistingConnectionSuggestions(db, sources)
    : undefined;
  // A selected read proves each edge's winner, not every candidate's freshness:
  // an existing proposal replaces the edge's recommendations, otherwise the newest
  // fresh one wins. Same-edge proposals share their groups, so one set decides
  // every group, and a stale candidate decides nothing. An edge's position can then
  // follow its winner rather than its oldest fresh candidate, which only a full
  // check could find; the selected caller, Recommendation.rows, reads rows by ID.
  const decidedEdges = selectedExisting
    ? new Set(selectedExisting.flat().map(edgeKey))
    : undefined;
  const admitted = new Set<ConnectionProposal>();
  await forEachConnectionBasis(
    db,
    (decidedEdges
      ? liveProposals.filter((p) => !decidedEdges.has(edgeKey(p))).reverse()
      : liveProposals
    ).map((candidate) => ({ candidate })),
    async ({ candidate: proposal }, basis) => {
      // A stale result still needs the inputs that could make it current again.
      observeBasis?.(
        proposal.review.suggestionId,
        connectionCandidate.parse(proposal),
        basis,
      );
      if (
        (await sha256CanonicalJson({
          version: 1,
          candidate: connectionCandidate.parse(proposal),
          basis,
        })) === proposal.fingerprint
      ) {
        admitted.add(proposal);
        decidedEdges?.add(edgeKey(proposal));
      }
    },
    undefined,
    decidedEdges && (({ candidate }) => decidedEdges.has(edgeKey(candidate))),
  );
  const fresh = liveProposals.filter((proposal) => admitted.has(proposal));
  // Unbounded callers retain the original freshness-before-existing read order.
  const existing =
    selectedExisting ?? (await readExistingConnectionSuggestions(db, sources));
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
      proposals.map((proposal) => [edgeKey(proposal), proposal]),
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

/**
 * Stored proposals for a page of pending Suggestions, read without rechecking
 * their basis. Review revalidates the fingerprint when one is accepted, so a
 * stale row can be listed but not applied. Deleted or merged endpoints drop out.
 */
export async function readStoredConnectionProposals(
  db: Database,
  ids: readonly string[],
): Promise<ConnectionProposal[]> {
  if (!ids.length) return [];
  const rows = await getDb(db)
    .select({ prediction: connectionReadSelection })
    .from(suggestionTable)
    .where(
      and(
        sql`${suggestionTable.id} = ANY(${uuidArrayParam(ids)})`,
        eq(suggestionTable.active, true),
        eq(suggestionTable.status, "pending"),
      ),
    );
  const proposals = rows.flatMap(({ prediction }) =>
    storedConnectionProposal(prediction),
  );
  const refs = await resolveShortcodes(db, [
    ...new Set(
      proposals.flatMap((p) => [p.source.entityId, p.target.entityId]),
    ),
  ]);
  const names = await lookupEntityLabels(db, [...refs.values()]);
  const name = (code: string) => {
    const ref = refs.get(code);
    return ref ? names.get(`${ref.entity}:${ref.id}`) : undefined;
  };
  return proposals.flatMap((proposal) =>
    refs.has(proposal.source.entityId) && refs.has(proposal.target.entityId)
      ? [
          {
            ...proposal,
            sourceName: name(proposal.source.entityId),
            targetName: name(proposal.target.entityId),
          },
        ]
      : [],
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
  z.infer<typeof suggestionReviewInput>,
  "verdict" | "expectedFingerprint" | "correction"
>;
/** Called only by reviewSuggestion, which owns the atomic application receipt. */
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
      .select(connectionReadSelection)
      .from(suggestionTable)
      .where(eq(suggestionTable.id, state.id))
      .limit(1);
    if (!prediction || prediction.family !== "recommendation")
      throw new Error("Connection Suggestion not found");
    const subject = suggestionSubjects.recommendation.parse(prediction.subject);
    const evidence = connectionReadEvidence.parse(prediction.evidence);
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
        "Connection Suggestion does not match its declared endpoints",
      );
    const basis = await captureConnectionBasis(db, candidate, true);
    const [freshState] = await getDb(db)
      .select(suggestionStateColumns)
      .from(suggestionTable)
      .where(eq(suggestionTable.id, state.id))
      .limit(1)
      .for("update");
    if (!freshState?.active || freshState.status !== "pending")
      throw new Error("Connection Suggestion is no longer pending");
    if (
      !input.expectedFingerprint ||
      input.expectedFingerprint !== prediction.fingerprint ||
      (await sha256CanonicalJson({ ...evidence, basis })) !==
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
          `Connection ${candidate.relation} requires its existing family Suggestion action`,
        );
    }
  });
}

/** A matching snapshot never authorizes replacing an existing acquisition decision. */
async function assertAcquisitionConnectionEligible(
  db: Database,
  candidate: ConnectionCandidate,
): Promise<void> {
  await assertAcquisitionConnectionsEligible(db, [candidate]);
}

async function assertAcquisitionConnectionsEligible(
  db: Database,
  candidates: readonly ConnectionCandidate[],
): Promise<void> {
  const expenses = candidates.flatMap((candidate) =>
    candidate.relation === "product-expense" ? [candidate.target.entityId] : [],
  );
  const pairs = candidates.flatMap((candidate) =>
    candidate.relation === "product-purchase"
      ? [
          {
            productCode: candidate.source.entityId,
            purchaseCode: candidate.target.entityId,
          },
        ]
      : [],
  );
  const [eligibleExpenses, eligiblePairs] = await Promise.all([
    eligibleConnectionExpenses(db, expenses),
    eligibleAcquisitionPairs(db, pairs),
  ]);
  if (expenses.some((code) => !eligibleExpenses.has(code)))
    throw new Error(
      "Connection Expense is no longer eligible for acquisition or is already assigned to a Product",
    );
  if (
    pairs.some(
      (pair) =>
        !eligiblePairs.has(
          acquisitionPairKey(pair.productCode, pair.purchaseCode),
        ),
    )
  )
    throw new Error(
      "Connection Product/Purchase pair is no longer eligible because acquisition is already recorded",
    );
}
