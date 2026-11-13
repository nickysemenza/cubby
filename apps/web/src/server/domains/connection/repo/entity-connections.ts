import type { ActorContext } from "@cubby/schemas/context";
import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionCandidate,
  connectionProposal,
  connectionSuggestionEvidence,
  type ConnectionCandidate,
  type ConnectionProposal,
} from "@cubby/schemas/entity-connections";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { connectionCandidateEvidence } from "~/server/db/retained-tables";
import { JobEvidenceObsoleteError } from "~/server/generic/jobs/errors";
import {
  lookupEntityLabels,
  resolveOrThrow,
  resolveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "~/server/lib/canonical-json";

import {
  captureConnectionBasis,
  forEachConnectionBasis,
  prepareConnectionBases,
} from "./connection-evidence";
import { connectionEvidence, connectionSubject } from "./connection-kernel";
import { applyEmailConnection } from "./email-connections";
import { readExistingConnectionSuggestions } from "./existing-suggestions";

function connectionApplicationParts(
  candidate: ConnectionCandidate,
  basis: unknown,
) {
  const parsed = z
    .object({
      dependencies: z
        .object({
          originalId: z.string(),
          eventId: z.string(),
          expectedChecksum: z.string(),
          evidence: z.array(
            z
              .object({
                eventId: z.string().nullable(),
                kind: z.string(),
                purchaseId: z.string().nullable(),
              })
              .passthrough(),
          ),
        })
        .nullable(),
    })
    .safeParse(basis);
  const dependency = parsed.success ? parsed.data.dependencies : null;
  return {
    email: candidate.source.entityId,
    purchase: candidate.target.entityId,
    original: dependency?.originalId ?? null,
    event: dependency?.eventId ?? null,
    checksum: dependency?.expectedChecksum ?? null,
    links:
      dependency?.evidence
        .filter(
          (row) => row.eventId === dependency.eventId && row.kind === "linked",
        )
        .map((row) => row.purchaseId)
        .sort() ?? [],
  };
}

async function connectionApplicationKeyFor(
  candidate: ConnectionCandidate,
  basis: unknown,
) {
  return sha256CanonicalJson(connectionApplicationParts(candidate, basis));
}

export type PreparedEntityConnection = z.infer<
  typeof connectionSuggestionEvidence
>;
export async function prepareEntityConnectionEvidence(
  db: Database,
  raws: readonly ConnectionCandidate[],
  expenseProjects?: Parameters<typeof prepareConnectionBases>[2],
): Promise<PreparedEntityConnection[]> {
  const prepared: PreparedEntityConnection[] = [];
  await forEachConnectionBasis(
    db,
    raws.map((raw) => ({ candidate: connectionCandidate.parse(raw) })),
    async ({ candidate }, basis) => {
      prepared.push({ version: 1, candidate, basis });
    },
    expenseProjects,
  );
  return prepared;
}

/** Append captured retrieval evidence; the reconciler derives the review gaps. */
export async function publishPreparedEntityConnections(
  db: Database,
  prepared: readonly PreparedEntityConnection[],
): Promise<ConnectionProposal[]> {
  return withTransactionDatabase(db, async (tx) => {
    const { append, evidenceRow, reconcileNow } =
      await import("~/server/kernel/api");
    const scopes = [];
    const ids = [];
    for (const entry of prepared) {
      const basis = await captureConnectionBasis(tx, entry.candidate, true);
      if (canonicalJson(basis) !== canonicalJson(entry.basis))
        throw new JobEvidenceObsoleteError(
          "Connection evidence changed after retrieval",
        );
      const candidate = entry.candidate;
      const sourceId = await resolveOrThrow(
        tx,
        z.enum(shortcodeEntities).parse(candidate.source.entityKind),
        candidate.source.entityId,
      );
      const targetId = await resolveOrThrow(
        tx,
        z.enum(shortcodeEntities).parse(candidate.target.entityKind),
        candidate.target.entityId,
      );
      const scopeKey = `${candidate.relation}:${sourceId}:${targetId}`;
      const fingerprint = await sha256CanonicalJson(entry);
      await append(tx, [
        evidenceRow(connectionEvidence, {
          scopeKey,
          fingerprint,
          sourceEntity: candidate.source.entityKind,
          sourceId,
          targetEntity: candidate.target.entityKind,
          targetId,
          candidate: z.json().parse(candidate),
          basis,
        }),
      ]);
      const [stored] = await getDb(tx)
        .select({ id: connectionCandidateEvidence.id })
        .from(connectionCandidateEvidence)
        .where(eq(connectionCandidateEvidence.fingerprint, fingerprint));
      if (stored) ids.push(stored.id);
      scopes.push({ kind: "connections", key: scopeKey });
    }
    await reconcileNow(tx, scopes);
    return readStoredConnectionProposals(tx, ids);
  });
}

export async function readStoredConnectionProposals(
  db: Database,
  ids?: readonly string[],
): Promise<ConnectionProposal[]> {
  const selected = await getDb(db)
    .select()
    .from(connectionCandidateEvidence)
    .where(
      and(
        ids ? inArray(connectionCandidateEvidence.id, [...ids]) : undefined,
        sql`EXISTS (SELECT 1 FROM "ScopeState" state WHERE state."scopeKind"=${"connections"}
      AND state."scopeKey"=${connectionCandidateEvidence.scopeKey} AND jsonb_array_length(state.gaps)>0
      AND NOT EXISTS (SELECT 1 FROM "ConnectionCandidateEvidence" newer WHERE newer."scopeKey"=${connectionCandidateEvidence.scopeKey}
        AND (newer."createdAt", newer.id)>(${connectionCandidateEvidence.createdAt}, ${connectionCandidateEvidence.id})))`,
      ),
    );
  const proposals = [];
  for (const row of selected) {
    const candidate = connectionCandidate.parse(row.candidate);
    let basis;
    try {
      basis = await captureConnectionBasis(db, candidate);
    } catch {
      // SILENT: a removed endpoint cannot offer a current connection.
      continue;
    }
    if (canonicalJson(basis) !== canonicalJson(row.basis)) continue;
    const refs = await resolveShortcodes(db, [
      candidate.source.entityId,
      candidate.target.entityId,
    ]);
    if (refs.size !== 2) continue;
    const labels = await lookupEntityLabels(db, [...refs.values()]);
    const label = (code: string) => {
      const ref = refs.get(code);
      return ref ? labels.get(`${ref.entity}:${ref.id}`) : undefined;
    };
    proposals.push(
      connectionProposal.parse({
        ...candidate,
        sourceName: label(candidate.source.entityId),
        targetName: label(candidate.target.entityId),
        fingerprint: await connectionApplicationKeyFor(candidate, basis),
        review: { suggestionId: row.id, suppression: null },
        integration: { kind: "connection-review" },
      }),
    );
  }
  return proposals;
}

export async function readEntityConnections(
  db: Database,
  source: EntityRef,
): Promise<ConnectionProposal[]> {
  const proposals = await readStoredConnectionProposals(db);
  return [
    ...proposals.filter((p) =>
      [p.source, p.target].some(
        (ref) =>
          ref.entityKind === source.entityKind &&
          ref.entityId === source.entityId,
      ),
    ),
    ...((await readExistingConnectionSuggestions(db, [source]))[0] ?? []),
  ];
}

/** The member's exact edge choice shares the source publication fence and kernel Decision transaction. */
export async function decideConnection(
  db: Database,
  actor: ActorContext,
  input: {
    id: string;
    fingerprint: string;
    accept: boolean;
    operationId: string;
  },
) {
  return withTransactionDatabase(db, async (tx) => {
    const [row] = await getDb(tx)
      .select()
      .from(connectionCandidateEvidence)
      .where(eq(connectionCandidateEvidence.id, input.id));
    if (!row) return null;
    const candidate = connectionCandidate.parse(row.candidate);
    const basis = await captureConnectionBasis(tx, candidate, true);
    if (
      (await connectionApplicationKeyFor(candidate, row.basis)) !==
        input.fingerprint ||
      canonicalJson(connectionApplicationParts(candidate, basis)) !==
        canonicalJson(connectionApplicationParts(candidate, row.basis))
    )
      throw new JobEvidenceObsoleteError(
        "Connection evidence changed since review",
      );
    if (input.accept) {
      if (candidate.relation !== "email-purchase")
        throw new Error(
          "This relation is decided through its field or identity command",
        );
      await applyEmailConnection(tx, candidate, basis, actor);
    }
    const { decide, reconcileNow } = await import("~/server/kernel/api");
    const [decision] = await decide(tx, actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: connectionSubject(row.scopeKey),
        field: "link",
        value: input.accept,
        proposalHash: input.operationId,
        scopes: [{ kind: "connections", key: row.scopeKey }],
      },
    ]);
    await reconcileNow(tx, [{ kind: "connections", key: row.scopeKey }]);
    return decision!;
  });
}
