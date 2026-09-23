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
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { importRun, ledgerParty, user } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * The actor for work with nobody behind it: crons, retries, scheduled
 * refreshes. Work a member starts (a backfill button) stays attributed to
 * that member. The reserved user exists in the production database.
 */
const SYSTEM_USER_ID: UserId = userId.parse("cubby-system");
export const systemActor = (): ActorContext =>
  buildActorContext(SYSTEM_USER_ID, "system");

/**
 * The run that owns AI usage recorded before every call had a run, and any
 * usage whose run is gone. The reserved run exists in the production database.
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
   * A non-ephemeral run is `running` until its owner completes it. Pass
   * `completed` for one that groups a member's discrete steps with no end
   * signal (EPUB imports).
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
    // Only import runs carry a member scope. Ephemeral runs have none, so
    // thousands of Jev passes never block a member's delete or merge
    // (`LEDGER_PARTY_*_EDGE_POLICY`); the actor snapshot still names who
    // started them.
    ledgerPartyId: trigger === "ephemeral" ? null : snapshot.ledgerPartyId,
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

// The actor's member party; the system user (and a member not yet linked to
// a party) has none.
async function actorSnapshot(database: ReturnType<typeof getDb>, id: UserId) {
  const [actor] = await database
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  if (!actor) throw new Error(`Run actor ${id} does not exist`);
  const [party] = await database
    .select({
      id: ledgerParty.id,
      shortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
      kind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, id),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  return {
    actorName: actor.name,
    actorEmail: actor.email,
    ledgerPartyId: party?.id ?? null,
    ledgerPartyShortcode: party?.shortcode ?? null,
    ledgerPartyName: party?.name ?? null,
    ledgerPartyKind: party?.kind ?? null,
  };
}
