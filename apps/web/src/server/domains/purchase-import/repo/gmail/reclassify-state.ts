import type { ActorContext } from "@cubby/schemas/context";
import type { ExecutionAuthorizationRef } from "@cubby/schemas/execution-authorization";
import type { RunId } from "@cubby/schemas/identifiers";
import {
  mailReclassifyRunInput,
  type MailReclassifyRunInput,
} from "@cubby/schemas/run-fields";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { email as emailTable, ledgerParty, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { prepareReclassification } from "./reclassification-work";

/** Member-owned Gmail Emails and the Runs that hold a member-requested rerun. */

export type OwnedEmail = typeof emailTable.$inferSelect;

export async function ownedEmailRows(
  db: Database,
  actor: ActorContext,
  filter:
    | { shortcodes: readonly string[] }
    | { mailboxId: string; messageId: string },
) {
  if (actor.runId)
    throw new Error("Only a member without a Run can reclassify Emails.");
  return getDb(db)
    .select({ email: emailTable })
    .from(emailTable)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, emailTable.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        "shortcodes" in filter
          ? inArray(emailTable.shortcode, [...filter.shortcodes])
          : and(
              eq(emailTable.mailboxId, filter.mailboxId),
              eq(emailTable.messageId, filter.messageId),
            ),
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
      ),
    );
}

export async function ownedEmails(
  db: Database,
  codes: readonly string[],
  actor: ActorContext,
) {
  const rows = await ownedEmailRows(db, actor, { shortcodes: codes });
  const found = new Map(rows.map(({ email }) => [email.shortcode, email]));
  const missing = codes.filter((code) => !found.has(code));
  if (missing.length)
    throw new Error(
      `No live Gmail Email owned by this member: ${missing.join(", ")}`,
    );
  return codes.map((code) => found.get(code)!);
}

/** The most recently created of `runIds`. */
export async function newestRunId(db: Database, runIds: readonly RunId[]) {
  const [latest] = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(inArray(run.id, [...runIds]))
    .orderBy(desc(run.createdAt), desc(run.id))
    .limit(1);
  return latest?.id;
}

export async function finishReclassifyRun(
  db: Database,
  runId: RunId,
  notes: readonly string[],
  receiptFailure = false,
) {
  // A budget pause (`needs_review`) keeps its status and failure code.
  await getDb(db)
    .update(run)
    .set({
      status: receiptFailure ? "failed" : "completed",
      endedAt: new Date(),
      notes: notes.length ? notes.join("\n").slice(0, 2_000) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(run.id, runId), eq(run.status, "running")));
}

/**
 * One Run per mailbox holds the rerun's model usage and observations. It binds
 * the member's Gmail execution approval for that mailbox and never becomes the
 * Email's processing Run, so later discovery refreshes are not frozen by it.
 */
export async function startReclassifyRun(
  db: Database,
  actor: ActorContext,
  mode: MailReclassifyRunInput["mode"],
  emails: readonly OwnedEmail[],
  executionAuthorization: ExecutionAuthorizationRef,
) {
  const [first] = emails;
  if (!first) throw new Error("Reclassify needs at least one Email.");
  const runId = await ensureRun(
    db,
    { ...actor, runId: null },
    {
      purpose: mode === "relevance" ? "mail_reclassify" : "background",
      trigger: "manual",
      status: "running",
      progress:
        mode === "relevance"
          ? {
              kind: "mail_reclassification",
              version: 1,
              complete: false,
              results: [],
              attempt: 0,
            }
          : undefined,
      input: mailReclassifyRunInput.parse({
        kind: "mail_reclassify",
        mode,
        executionAuthorization,
        mailboxId: first.mailboxId,
        emails: emails.map((email) => ({
          emailId: email.id,
          checksum: email.checksum,
        })),
      }),
    },
  );
  const [created] = await getDb(db)
    .select({ ledgerPartyId: run.ledgerPartyId, shortcode: run.shortcode })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1);
  if (created?.ledgerPartyId !== first.ledgerPartyId) {
    const message =
      "Reclassify Run owner differs from the Email owner; reclassify each member's Emails separately.";
    await finishReclassifyRun(db, runId, [message]);
    throw new Error(message);
  }
  return { id: runId, shortcode: created.shortcode };
}

/** One prepared relevance rerun per mailbox batch, created together or not at all. */
export async function startPreparedReclassifyRuns(
  db: Database,
  actor: ActorContext,
  batches: readonly {
    group: readonly OwnedEmail[];
    approval: ExecutionAuthorizationRef;
  }[],
) {
  return withTransactionDatabase(db, async (tx) => {
    const runs = [];
    for (const { group, approval } of batches) {
      const started = await startReclassifyRun(
        tx,
        actor,
        "relevance",
        group,
        approval,
      );
      await prepareReclassification(tx, started.id, group, approval);
      runs.push(started);
    }
    return runs;
  });
}
