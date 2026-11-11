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
import {
  suggestionReviewInput,
  suggestionSubjects,
  type SuggestionProducer,
} from "@cubby/schemas/suggestion";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  uuidArrayParam,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { suggestionTable, entityIdentity } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { JobEvidenceObsoleteError } from "~/server/generic/jobs/errors";
import {
  lookupEntityLabels,
  resolveShortcodes,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { memberRejectedSql } from "~/server/generic/suggestions/repo/suggestion-decisions";
import {
  publishSuggestionSet,
  type SuggestionFamily,
  type SuggestionRow,
} from "~/server/generic/suggestions/repo/suggestion-publication";
import { recommendationSlot } from "~/server/generic/suggestions/repo/suggestion-recommendation";
import {
  suggestionCandidateKey,
  suggestionStateColumns,
} from "~/server/generic/suggestions/repo/suggestion-state";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "~/server/lib/canonical-json";

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
  return prepared;
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
    const entries: ConnectionEntry[] = [];
    for (const original of prepared) {
      const { candidate } = original;
      const { basis, sourceId } = await captureConnectionEvidence(
        db,
        candidate,
        true,
        locked,
      );
      if (canonicalJson(basis) !== canonicalJson(original.basis))
        throw new JobEvidenceObsoleteError(
          "Connection evidence changed after candidate retrieval; discover again before publishing",
        );
      if (
        candidate.relation === "email-purchase" &&
        !z
          .object({ dependencies: z.object({ eventId: z.string() }) })
          .safeParse(basis).success
      )
        throw new JobEvidenceObsoleteError(
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
    // Several page owners may retrieve the same edge. Sequential publication
    // leaves the last fingerprint active, so the last candidate per slot wins.
    const slotOf = (entry: ConnectionEntry) =>
      connectionSuggestions.slot(entry).lock;
    const winners = [
      ...new Map(entries.map((entry) => [slotOf(entry), entry])).values(),
    ];
    const outcomes = await publishSuggestionSet(
      db,
      connectionSuggestions,
      winners,
      connectionProducer,
    );
    const ids = new Map(
      winners.flatMap((entry, index) => {
        const outcome = outcomes[index];
        const id =
          outcome?.outcome === "published"
            ? outcome.suggestionId
            : outcome?.outcome === "unchanged"
              ? outcome.rows[0]?.id
              : undefined;
        return id ? [[slotOf(entry), id] as const] : [];
      }),
    );
    return entries.flatMap((entry) => {
      const suggestionId = ids.get(slotOf(entry));
      if (!suggestionId) return [];
      return [
        connectionProposal.parse({
          ...entry.candidate,
          fingerprint: entry.fingerprint,
          review: {
            suggestionId,
            suppression: {
              scope: entry.scope,
              candidateKey: entry.candidateKey,
              fingerprint: null,
            },
          },
          integration: { kind: "connection-review" },
        }),
      ];
    });
  });
}

type ConnectionEntry = {
  candidate: ConnectionCandidate;
  fingerprint: string;
  candidateKey: string;
  scope: string;
  entity: (typeof shortcodeEntities)[number];
  recordId: string;
  evidence: { version: number; candidate: ConnectionCandidate };
};

/** Deterministic discovery: rows carry no producer. */
const connectionProducer: SuggestionProducer = {
  kind: "rule",
  model: null,
  revision: null,
  runId: null,
  evaluationId: null,
};

/**
 * Connection recommendations: one slot per source record and candidate edge.
 * Only an Email purchase link has an apply path.
 */
const connectionSuggestions: SuggestionFamily<
  ConnectionEntry,
  SuggestionRow,
  "unsupported_relation"
> = {
  family: "recommendation",
  slot: (entry) => recommendationSlot(entry),
  fingerprint: (entry) => entry.fingerprint,
  evidenceFingerprint: (entry) => entry.fingerprint,
  unapplicable: ({ candidate }) =>
    candidate.relation === "email-purchase" ? null : "unsupported_relation",
  onUnchanged: "none",
  publication: (entry) => ({
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
  }),
  labelBacklog: sql`false`,
};

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
            isNull(entityIdentity.deletedAt),
            isNull(entityIdentity.mergedIntoId),
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
      input.expectedFingerprint !== prediction.fingerprint ||
      (await sha256CanonicalJson({ ...evidence, basis })) !==
        prediction.fingerprint
    )
      throw new Error(
        "Connection evidence changed; discover again before applying",
      );
    const actor = context.actorContext;
    switch (candidate.relation) {
      case "email-purchase":
        await applyEmailConnection(db, candidate, basis, actor);
        break;
      default:
        throw new Error(
          `Connection ${candidate.relation} requires its existing family Suggestion action`,
        );
    }
  });
}
