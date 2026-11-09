import { suggestionStatus } from "@cubby/schemas/ai";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import type { RunId } from "@cubby/schemas/identifiers";
import { runFindingEntity } from "@cubby/schemas/purchase-import";
import { storedImportFix } from "@cubby/schemas/purchase-import";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { RunDetail } from "~/contracts/run.contract";
import type { Database, DrizzleTransaction } from "~/server/db";
import { databaseForTransaction, getDb } from "~/server/db/helpers";
import { runFinding } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";
import { canonicalJson } from "~/server/lib/canonical-json";

const status = suggestionStatus.enum;

export type RunFindingPublication = {
  runId: RunId | null;
  ledgerPartyId: LedgerPartyId;
  entityKind: z.infer<typeof runFindingEntity>;
  entityId: string;
  kind: string;
  summary: string;
  proposedFix: z.infer<ReturnType<typeof z.json>> | null;
  evidenceFingerprint: string;
  probability?: number | null;
  expiresAt?: Date | null;
  /** The import applied the fix itself; recorded as an automatic resolution. */
  autoApplied?: boolean;
};

/** One retained resolution of a finding; a finding keeps every one in order. */
const runFindingResolution = z.object({
  id: z.uuid(),
  operationId: z.string(),
  verdict: z.string(),
  correction: z.json().nullable(),
  reason: z.string().nullable(),
  evidence: z.json().nullable(),
  intent: z.string(),
  authority: z.string(),
  actorUserId: z.string().nullable(),
  receipt: z.json().nullable(),
  metadata: z.json().nullable(),
  createdAt: z.iso.datetime(),
});

/** The status reads show: retired and rejected findings read dismissed. */
export const runFindingStatus = z.enum(["open", "applied", "dismissed"]);

/** `open` while pending and current. */
export const runFindingStatusSql = sql<
  z.infer<typeof runFindingStatus>
>`CASE WHEN ${runFinding.status} = ${status.pending} AND ${runFinding.active} THEN ${runFindingStatus.enum.open} WHEN ${runFinding.status} = ${status.applied} THEN ${runFindingStatus.enum.applied} ELSE ${runFindingStatus.enum.dismissed} END`;

/** The finding as reads show it, with `status` in its presented vocabulary. */
export const runFindingColumns = {
  id: runFinding.id,
  runId: runFinding.runId,
  ledgerPartyId: runFinding.ledgerPartyId,
  entityKind: runFinding.entityKind,
  entityId: runFinding.entityId,
  kind: runFinding.kind,
  summary: runFinding.summary,
  proposedFix: runFinding.proposedFix,
  probability: runFinding.probability,
  expiresAt: runFinding.expiresAt,
  status: runFindingStatusSql,
  autoApplied: runFinding.autoApplied,
  createdAt: runFinding.createdAt,
};

/** Findings are shared by every Run purpose, independently of import detail. */
export async function loadRunFindings(
  db: Database,
  runId: RunId,
): Promise<RunDetail["findings"]> {
  const findings = await getDb(db)
    .select({
      id: runFindingColumns.id,
      kind: runFindingColumns.kind,
      summary: runFindingColumns.summary,
      status: runFindingColumns.status,
      proposedFix: runFindingColumns.proposedFix,
      autoApplied: runFindingColumns.autoApplied,
      probability: runFindingColumns.probability,
      createdAt: runFindingColumns.createdAt,
      expiresAt: runFindingColumns.expiresAt,
    })
    .from(runFinding)
    .where(eq(runFinding.runId, runId))
    .orderBy(asc(runFinding.createdAt), asc(runFinding.id));
  return findings.map((finding) => ({
    ...finding,
    proposedFix: storedImportFix.parse(finding.proposedFix),
    createdAt: finding.createdAt.toISOString(),
    expiresAt: finding.expiresAt?.toISOString() ?? null,
  }));
}

const laterDeadline = (current: Date | null, next: Date | null) =>
  current === null || next === null ? null : next > current ? next : current;

const resolutionEntry = (
  input: Pick<
    z.infer<typeof runFindingResolution>,
    "operationId" | "verdict" | "intent" | "authority" | "actorUserId"
  > &
    Partial<Pick<z.infer<typeof runFindingResolution>, "metadata" | "receipt">>,
) =>
  runFindingResolution.parse({
    id: crypto.randomUUID(),
    correction: { present: false },
    reason: null,
    evidence: null,
    receipt: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    ...input,
  });

const notifyFindings = (
  db: Database | DrizzleTransaction,
  entityKinds: readonly string[],
) =>
  recordChange(db, {
    kind: "projection",
    categories: [...new Set(["ai", "suggestions", "problems", ...entityKinds])],
  });

/**
 * One finding per member, record, kind and evidence. The same evidence found
 * again keeps a resolved finding resolved and extends an open one's deadline;
 * it never opens a second finding.
 */
export async function publishRunFinding(
  db: Database | DrizzleTransaction,
  input: RunFindingPublication,
): Promise<{ id: string; created: boolean; open: boolean }> {
  const database = "select" in db ? databaseForTransaction(db) : db;
  const publicationKey = [
    "run_finding:v1",
    input.ledgerPartyId,
    input.entityKind,
    input.entityId,
    input.kind,
    input.evidenceFingerprint,
  ].join(":");
  const expiresAt = input.expiresAt ?? null;
  const probability = input.probability ?? null;
  const [created] = await getDb(database)
    .insert(runFinding)
    .values({
      publicationKey,
      runId: input.runId,
      ledgerPartyId: input.ledgerPartyId,
      entityKind: input.entityKind,
      entityId: input.entityId,
      kind: input.kind,
      summary: input.summary,
      proposedFix: input.proposedFix,
      probability,
      expiresAt,
      evidenceFingerprint: input.evidenceFingerprint,
      judgment: {
        kind: input.kind,
        summary: input.summary,
        proposedFix: input.proposedFix,
        probability,
      },
      status: input.autoApplied ? status.applied : status.pending,
      autoApplied: input.autoApplied ?? false,
      resolutions: input.autoApplied
        ? [
            resolutionEntry({
              operationId: "import-applied",
              verdict: "correct",
              intent: "apply",
              authority: "automatic",
              actorUserId: null,
              receipt: { runId: input.runId },
              metadata: { kind: "run_finding_import", policy: "import" },
            }),
          ]
        : [],
    })
    .onConflictDoNothing({ target: runFinding.publicationKey })
    .returning({ id: runFinding.id });
  if (created) {
    await notifyFindings(database, [input.entityKind]);
    return { id: created.id, created: true, open: !input.autoApplied };
  }
  const [existing] = await getDb(database)
    .select({
      id: runFinding.id,
      active: runFinding.active,
      status: runFinding.status,
      expiresAt: runFinding.expiresAt,
      entityKind: runFinding.entityKind,
    })
    .from(runFinding)
    .where(eq(runFinding.publicationKey, publicationKey))
    .for("update");
  if (!existing) throw new Error("Run finding publication returned no row");
  const open = existing.active && existing.status === status.pending;
  const later = laterDeadline(existing.expiresAt, expiresAt);
  if (open && later?.getTime() !== existing.expiresAt?.getTime()) {
    await getDb(database)
      .update(runFinding)
      .set({ expiresAt: later })
      .where(eq(runFinding.id, existing.id));
    await notifyFindings(database, [existing.entityKind]);
  }
  return { id: existing.id, created: false, open };
}

/** Change what the current finding reads; `judgment` keeps the original. */
export async function updateRunFinding(
  db: Database | DrizzleTransaction,
  id: string,
  patch: Partial<
    Pick<
      typeof runFinding.$inferInsert,
      "proposedFix" | "summary" | "expiresAt" | "status"
    >
  >,
) {
  const database = "select" in db ? databaseForTransaction(db) : db;
  const [row] = await getDb(database)
    .update(runFinding)
    .set(patch)
    .where(eq(runFinding.id, id))
    .returning({ entityKind: runFinding.entityKind });
  if (row) await notifyFindings(database, [row.entityKind]);
}

/** Close a finding and retain who resolved it, on the same row. */
export async function resolveRunFindingRow(
  tx: DrizzleTransaction,
  id: string,
  input: {
    verdict: "correct" | "dismissed";
    intent: "apply" | "history";
    actorUserId: string;
    metadata?: z.infer<ReturnType<typeof z.json>>;
    status: "applied" | "rejected";
  },
) {
  const entry = resolutionEntry({
    operationId: "resolution",
    verdict: input.verdict,
    intent: input.intent,
    authority: "member",
    actorUserId: input.actorUserId,
    metadata: input.metadata ?? null,
  });
  const [row] = await tx
    .update(runFinding)
    .set({
      status: input.status,
      resolutions: sql`${runFinding.resolutions} || ${JSON.stringify([entry])}::jsonb`,
    })
    .where(eq(runFinding.id, id))
    .returning({ entityKind: runFinding.entityKind });
  if (!row) throw new Error("Import finding not found for this member.");
  await notifyFindings(tx, [row.entityKind]);
}

/** Retire every target's findings, keeping each one's key and resolutions. */
export async function retireRunFindingTargetsTx(
  tx: DrizzleTransaction,
  entityKind: string,
  entityIds: readonly string[],
) {
  if (!entityIds.length) return;
  const rows = await tx
    .update(runFinding)
    .set({ active: false, status: status.superseded })
    .where(
      and(
        eq(runFinding.entityKind, entityKind),
        inArray(runFinding.entityId, [...entityIds]),
      ),
    )
    .returning({ id: runFinding.id });
  if (rows.length) await notifyFindings(tx, [entityKind]);
}

/**
 * A finding follows a merge survivor with its review. An open finding the
 * survivor already carries for the same evidence is one finding.
 */
export async function repointRunFindingTargetsTx(
  tx: DrizzleTransaction,
  entityKind: string,
  keepId: string,
  loserIds: readonly string[],
) {
  if (!loserIds.length) return;
  const open = await tx
    .select()
    .from(runFinding)
    .where(
      and(
        eq(runFinding.entityKind, entityKind),
        eq(runFinding.entityId, keepId),
        eq(runFinding.active, true),
        eq(runFinding.status, status.pending),
      ),
    );
  const openKey = (row: typeof runFinding.$inferSelect) =>
    canonicalJson([row.ledgerPartyId, row.kind, row.evidenceFingerprint]);
  const survivorOpen = new Set(open.map(openKey));
  const losers = await tx
    .select()
    .from(runFinding)
    .where(
      and(
        eq(runFinding.entityKind, entityKind),
        inArray(runFinding.entityId, [...loserIds]),
      ),
    )
    .orderBy(asc(runFinding.id))
    .for("update");
  for (const row of losers) {
    const duplicate =
      row.active &&
      row.status === status.pending &&
      survivorOpen.has(openKey(row));
    if (row.active && row.status === status.pending && !duplicate)
      survivorOpen.add(openKey(row));
    await tx
      .update(runFinding)
      .set(
        duplicate
          ? { active: false, status: status.superseded }
          : { entityId: keepId },
      )
      .where(eq(runFinding.id, row.id));
  }
  if (losers.length) await notifyFindings(tx, [entityKind]);
}
