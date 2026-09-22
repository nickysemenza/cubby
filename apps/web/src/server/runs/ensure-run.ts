import { type ActorContext, buildActorContext } from "@cubby/schemas/context";
import {
  type ImportRunId,
  type UserId,
  importRunId,
  userId,
} from "@cubby/schemas/identifiers";
import {
  type ImportRunPurpose,
  importRunStatus,
} from "@cubby/schemas/import-run-fields";
import type { ImportRunTrigger } from "@cubby/schemas/purchase-import";
import { generateShortcode } from "@cubby/shared";
import { and, eq, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { importRun, ledgerParty, user } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * The actor for work with nobody behind it: crons, retries, scheduled
 * refreshes. Work a member starts (a backfill button) stays attributed to
 * that member. Seeded by `scripts/cutovers/run-attribution.sql`.
 */
export const SYSTEM_USER_ID: UserId = userId.parse("cubby-system");
export const systemActor = (): ActorContext =>
  buildActorContext(SYSTEM_USER_ID, "system");

/**
 * The run that owns AI usage recorded before every call had a run, and any
 * usage whose run is gone. Seeded by `scripts/cutovers/run-attribution.sql`.
 */
export const LEGACY_RUN_ID: ImportRunId = importRunId.parse(
  "00000000-0000-4000-8000-00000000c0de",
);

export type EnsureRunInput = {
  purpose: ImportRunPurpose;
  /** `ephemeral` (the default) creates the run already `completed`. */
  trigger?: ImportRunTrigger;
  /** Groups repeat calls into one run, e.g. one Jev pass per page mount. */
  clientKey?: string;
  /**
   * A non-ephemeral run is `running` until `finishRun`. Pass `completed` for
   * one that groups a user's discrete steps with no end signal (EPUB imports).
   */
  status?: "running" | "completed";
  notes?: string;
};

/**
 * The run this actor's work belongs to. An inherited run always wins (Flue's
 * token-scoped run, an import's own run), so nothing nests. Otherwise a new
 * run is inserted and committed on the root connection, never inside a
 * caller's transaction: AI usage rows reference it through the telemetry
 * queue, and a run rolled back with its caller would orphan them.
 */
export async function ensureRun(
  db: Database,
  actor: ActorContext,
  input: EnsureRunInput,
): Promise<ImportRunId> {
  if (actor.runId) return actor.runId;
  const database = getDb(db);
  const trigger = input.trigger ?? "ephemeral";
  const completed = trigger === "ephemeral" || input.status === "completed";
  const snapshot = await actorSnapshot(database, actor.userId);
  const now = new Date();
  const values = {
    id: importRunId.parse(crypto.randomUUID()),
    shortcode: generateShortcode("importRun"),
    // Ephemeral runs belong to the household, so thousands of Jev passes never
    // block a member's delete or merge (`LEDGER_PARTY_*_EDGE_POLICY`); the
    // actor snapshot still names who started them.
    ledgerPartyId:
      trigger === "ephemeral"
        ? snapshot.householdPartyId
        : snapshot.ledgerPartyId,
    actorUserId: actor.userId,
    actorName: snapshot.actorName,
    actorEmail: snapshot.actorEmail,
    actorLedgerPartyShortcode: snapshot.ledgerPartyShortcode,
    actorLedgerPartyName: snapshot.ledgerPartyName,
    actorLedgerPartyKind: snapshot.ledgerPartyKind,
    purpose: input.purpose,
    trigger,
    status: completed
      ? importRunStatus.enum.completed
      : importRunStatus.enum.running,
    startedAt: now,
    endedAt: completed ? now : null,
    channel: actor.channel,
    oauthClientId: actor.oauthClientId,
    deviceId: actor.deviceId,
    clientKey: input.clientKey ?? null,
    notes: input.notes ?? null,
  };
  const insert = database.insert(importRun).values(values);
  const [row] = input.clientKey
    ? await insert
        .onConflictDoUpdate({
          target: importRun.clientKey,
          targetWhere: sql`${importRun.clientKey} IS NOT NULL`,
          set: { endedAt: now },
        })
        .returning({ id: importRun.id })
    : await insert.returning({ id: importRun.id });
  if (!row) throw new Error(`Run for ${input.purpose} was not created`);
  return row.id;
}

/** Close a non-ephemeral run (a backfill, a file import) that `ensureRun` opened. */
export async function finishRun(
  db: Database,
  runId: ImportRunId,
  status: "completed" | "failed",
): Promise<void> {
  await getDb(db)
    .update(importRun)
    .set({ status, endedAt: new Date() })
    .where(eq(importRun.id, runId));
}

/** `actor` with its run set, opening one when nothing encloses the work. */
export async function actorWithRun(
  db: Database,
  actor: ActorContext,
  input: EnsureRunInput,
): Promise<ActorContext & { runId: ImportRunId }> {
  return { ...actor, runId: await ensureRun(db, actor, input) };
}

/**
 * One `file_import` run per cookbook groups its EPUB upsert and recipe
 * imports. Keyed by name because `upsertCookbook` identifies books by name.
 */
export const cookbookImportRunInput = (
  cookbookName: string,
): EnsureRunInput => ({
  purpose: "file_import",
  trigger: "manual",
  status: "completed",
  clientKey: `epub:${cookbookName}`,
});

// The system user has no member party, so its runs belong to the household.
async function actorSnapshot(database: ReturnType<typeof getDb>, id: UserId) {
  const [actor] = await database
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  if (!actor) throw new Error(`Run actor ${id} does not exist`);
  const parties = await database
    .select({
      id: ledgerParty.id,
      shortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
      kind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .where(
      and(
        notDeleted(ledgerParty),
        or(
          and(eq(ledgerParty.userId, id), eq(ledgerParty.kind, "member")),
          eq(ledgerParty.kind, "household"),
        ),
      ),
    );
  const household = parties.find((party) => party.kind === "household");
  const party =
    parties.find((candidate) => candidate.kind === "member") ?? household;
  if (!party || !household)
    throw new Error(`Run actor ${id} has no ledger party`);
  return {
    actorName: actor.name,
    actorEmail: actor.email,
    householdPartyId: household.id,
    ledgerPartyId: party.id,
    ledgerPartyShortcode: party.shortcode,
    ledgerPartyName: party.name,
    ledgerPartyKind: party.kind,
  };
}
