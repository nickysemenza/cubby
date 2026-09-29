import { type ActorContext, buildActorContext } from "@cubby/schemas/context";
import {
  type RunId,
  type UserId,
  runEntityId,
  userId,
} from "@cubby/schemas/identifiers";
import type { RunTrigger } from "@cubby/schemas/purchase-import";
import { type RunPurpose, runStatus } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run as runTable, ledgerParty, user } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
  type ShortcodeGeneratorPort,
} from "~/server/repo/shortcode-utils";

/**
 * The actor for work with nobody behind it: crons, retries, scheduled
 * refreshes. Work a member starts (a backfill button) stays attributed to
 * that member. The reserved user exists in the production database.
 */
const SYSTEM_USER_ID: UserId = userId.parse("cubby-system");
export const systemActor = (): ActorContext =>
  buildActorContext(SYSTEM_USER_ID, "system");

export type EnsureRunInput = {
  purpose: RunPurpose;
  /** `ephemeral` (the default) creates the run already `completed`. */
  trigger?: RunTrigger;
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
  generator?: ShortcodeGeneratorPort,
): Promise<RunId> {
  if (actor.runId) return actor.runId;
  const database = getDb(db);
  const trigger = input.trigger ?? "ephemeral";
  const completed = trigger === "ephemeral" || input.status === "completed";
  const snapshot = await actorSnapshot(database, actor.userId);
  const now = new Date();
  const values = {
    id: runEntityId.parse(crypto.randomUUID()),
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
    status: completed ? runStatus.enum.completed : runStatus.enum.running,
    startedAt: now,
    endedAt: completed ? now : null,
    channel: actor.channel,
    oauthClientId: actor.oauthClientId,
    deviceId: actor.deviceId,
    clientKey: input.clientKey ?? null,
    notes: input.notes ?? null,
  };
  if (!input.clientKey) {
    return (await insertWithShortcode(db, "run", values, generator)).id;
  }
  const result = await findOrCreateWithShortcode(
    db,
    "run",
    { where: eq(runTable.clientKey, input.clientKey), values: () => values },
    generator,
  );
  if (!result.created) {
    await database
      .update(runTable)
      .set({ endedAt: now })
      .where(eq(runTable.id, result.row.id));
  }
  return result.row.id;
}

/**
 * Where an AI call's usage is filed when the caller has no run of its own.
 * A page's `runKey` groups every suggestion the page asks for into one run;
 * every other caller shares one run per actor, channel and UTC hour, so a
 * burst of previews or one-off actions is one `ai_suggest` run, not one each.
 * `now` is a parameter so the hour boundary is testable.
 */
export function aiCallRunInput(
  actor: ActorContext,
  options: { runKey?: string; now?: Date } = {},
): EnsureRunInput {
  if (options.runKey)
    return { purpose: "ai_suggest", clientKey: `jev:${options.runKey}` };
  const hour = (options.now ?? new Date()).toISOString().slice(0, 13);
  // The system user is one actor by definition; the MCP session id is not on
  // `ActorContext`, so an MCP actor's calls group by user instead.
  const who = actor.channel === "system" ? "" : `${actor.userId}:`;
  return {
    purpose: "ai_suggest",
    clientKey: `${actor.channel}:${who}${hour}`,
  };
}

/** `actor` with its run set, opening one when nothing encloses the work. */
export async function actorWithRun(
  db: Database,
  actor: ActorContext,
  input: EnsureRunInput,
): Promise<ActorContext & { runId: RunId }> {
  return { ...actor, runId: await ensureRun(db, actor, input) };
}

/**
 * One `file_import` run per cookbook groups its EPUB upsert and recipe
 * imports. Keyed by name because `upsertCookbook` identifies books by name.
 */
export const cookbookRunInput = (cookbookName: string): EnsureRunInput => ({
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
