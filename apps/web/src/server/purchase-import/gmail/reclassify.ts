import type { ActorContext } from "@cubby/schemas/context";
import {
  reclassifyEmailsInput,
  reclassifyEmailsOut,
  rerunEmailPreviewInput,
  rerunEmailPreviewOut,
  type EmailReclassifyOutcome,
  type ReclassifyEmailsInput,
  type ReclassifyEmailsOut,
  type RerunEmailPreviewInput,
  type RerunEmailPreviewOut,
} from "@cubby/schemas/email-actions";
import { parseShortcodeFor, type RunId } from "@cubby/schemas/identifiers";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { and, desc, eq, inArray } from "drizzle-orm";
import { groupBy } from "es-toolkit";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import {
  email as emailTable,
  emailClassificationObservation,
  ledgerParty,
  run,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";
import { latestExecutionAuthorization } from "~/server/runs/execution-context";

import {
  deferClassificationRefresh,
  publishGmailEvidence,
} from "./admitted-source";
import {
  extractEmailCandidatePreview,
  type EmailCandidateChoice,
} from "./candidate-extraction";
import { ingestGmailMessages } from "./ingest";
import { recordEmailCandidateObservation } from "./observations";
import { gmailProviderForUser } from "./provider";

type IngestPorts = Pick<
  Parameters<typeof ingestGmailMessages>[2],
  "triage" | "relevance" | "candidateChoice" | "storage"
>;
type OwnedEmail = typeof emailTable.$inferSelect;

async function ownedEmails(
  db: Database,
  codes: readonly string[],
  actor: ActorContext,
) {
  if (actor.runId)
    throw new Error("Only a member without a Run can reclassify Emails.");
  const rows = await getDb(db)
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
        inArray(emailTable.shortcode, [...codes]),
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
      ),
    );
  const found = new Map(rows.map(({ email }) => [email.shortcode, email]));
  const missing = codes.filter((code) => !found.has(code));
  if (missing.length)
    throw new Error(
      `No live Gmail Email owned by this member: ${missing.join(", ")}`,
    );
  return codes.map((code) => found.get(code)!);
}

/**
 * One Run per mailbox holds the rerun's model usage and observations. It binds
 * the member's Gmail execution approval for that mailbox and never becomes the
 * Email's processing Run, so later discovery refreshes are not frozen by it.
 */
async function startReclassifyRun(
  db: Database,
  actor: ActorContext,
  mode: "relevance" | "preview",
  emails: readonly OwnedEmail[],
) {
  const [first] = emails;
  if (!first) throw new Error("Reclassify needs at least one Email.");
  const owner = { userId: actor.userId, ledgerPartyId: first.ledgerPartyId };
  const executionAuthorization =
    (await latestExecutionAuthorization(
      db,
      owner,
      first.mailboxId,
      "backfill",
    )) ??
    (await latestExecutionAuthorization(
      db,
      owner,
      first.mailboxId,
      "continuous",
    ));
  const runId = await ensureRun(
    db,
    { ...actor, runId: null },
    {
      purpose: "background",
      trigger: "manual",
      status: "running",
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
  if (created?.ledgerPartyId !== first.ledgerPartyId)
    throw new Error(
      "Reclassify Run owner differs from the Email owner; reclassify each member's Emails separately.",
    );
  return { id: runId, shortcode: created.shortcode };
}

async function finishReclassifyRun(
  db: Database,
  runId: RunId,
  failures: readonly string[],
) {
  await getDb(db)
    .update(run)
    .set({
      status: "completed",
      endedAt: new Date(),
      notes: failures.length ? failures.join("\n").slice(0, 2_000) : null,
      updatedAt: new Date(),
    })
    .where(eq(run.id, runId));
}

function ingestOutcome(
  outcome: Awaited<ReturnType<typeof ingestGmailMessages>>,
): EmailReclassifyOutcome {
  if (outcome.deleted.length || outcome.excluded.length) return "removed";
  const kept = outcome.kept[0];
  if (kept) return kept.reason;
  if (outcome.confirmed.length) return "confirmed";
  if (
    outcome.saved.length ||
    outcome.unrelated.length ||
    outcome.blocked.length
  )
    return "replaced";
  // Publication declined: an import admitted this source meanwhile.
  return "frozen";
}

/** Rerun Relevance for selected Emails from their Gmail originals. */
export async function reclassifyEmails(
  db: Database,
  rawInput: ReclassifyEmailsInput,
  actor: ActorContext,
  ports: IngestPorts = {},
): Promise<ReclassifyEmailsOut> {
  const input = reclassifyEmailsInput.parse(rawInput);
  const emails = await ownedEmails(db, [...new Set(input.ids)], actor);
  const groups = groupBy(
    emails,
    (email) => `${email.ledgerPartyId}\u0000${email.mailboxId}`,
  );
  const results: ReclassifyEmailsOut["results"] = [];
  const runIds: string[] = [];
  for (const group of Object.values(groups)) {
    const created = await startReclassifyRun(db, actor, "relevance", group);
    runIds.push(created.shortcode);
    const failures: string[] = [];
    let provider: Awaited<ReturnType<typeof gmailProviderForUser>> | null =
      null;
    for (const email of group) {
      const result = {
        id: parseShortcodeFor("email", email.shortcode),
        classification: null,
        stage: null,
        conflict: false,
        error: null,
      };
      try {
        if (
          await deferClassificationRefresh(db, "classification_only", email)
        ) {
          results.push({ ...result, outcome: "frozen" });
          continue;
        }
        provider ??= await gmailProviderForUser(
          db,
          actor.userId,
          email.mailboxId,
        );
        const outcome = await ingestGmailMessages(db, provider, {
          ...ports,
          ledgerPartyId: email.ledgerPartyId,
          mailboxId: email.mailboxId,
          messageIds: [email.messageId],
          runId: created.id,
          reclassify: true,
        });
        const [observed] = await getDb(db)
          .select()
          .from(emailClassificationObservation)
          .where(
            and(
              eq(emailClassificationObservation.emailId, email.id),
              eq(emailClassificationObservation.runId, created.id),
            ),
          )
          .orderBy(desc(emailClassificationObservation.createdAt))
          .limit(1);
        results.push({
          ...result,
          outcome: ingestOutcome(outcome),
          classification: observed?.classification ?? null,
          stage: observed?.stage ?? null,
          conflict: observed?.conflict?.kind === "member_review",
        });
      } catch (error) {
        const message = scrubErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
        failures.push(`${email.shortcode}: ${message}`);
        results.push({ ...result, outcome: "failed", error: message });
      }
    }
    await finishReclassifyRun(db, created.id, failures);
  }
  const order = new Map(input.ids.map((code, index) => [code, index]));
  results.sort((left, right) => order.get(left.id)! - order.get(right.id)!);
  return reclassifyEmailsOut.parse({ runIds, results });
}

/** Rerun the cheap extraction preview for one related, retained Email. */
export async function rerunEmailPreview(
  db: Database,
  rawInput: RerunEmailPreviewInput,
  actor: ActorContext,
  ports: { choose?: EmailCandidateChoice } = {},
): Promise<RerunEmailPreviewOut> {
  const input = rerunEmailPreviewInput.parse(rawInput);
  const [email] = await ownedEmails(db, [input.id], actor);
  if (!email || email.checksum !== input.expectedChecksum)
    throw new Error("Email evidence changed; refresh before rerunning.");
  if (email.classification !== "related")
    throw new Error("Only a related Email has an extraction preview.");
  const created = await startReclassifyRun(db, actor, "preview", [email]);
  try {
    const preview = await extractEmailCandidatePreview(
      db,
      {
        emailId: email.id,
        ledgerPartyId: email.ledgerPartyId,
        runId: created.id,
      },
      ports,
    );
    const published = await publishGmailEvidence(
      db,
      {
        ledgerPartyId: email.ledgerPartyId,
        mailboxId: email.mailboxId,
        messageId: email.messageId,
        runId: created.id,
        executionPolicy: "classification_only",
        expected: email,
      },
      async (tx) => {
        await recordEmailCandidateObservation(tx, {
          emailId: email.id,
          preview,
        });
        return preview;
      },
    );
    if (!published)
      throw new Error(
        "Email changed or was admitted to an import during the preview; refresh before rerunning.",
      );
    await finishReclassifyRun(db, created.id, []);
    return rerunEmailPreviewOut.parse({
      runId: created.shortcode,
      status: published.status,
      reason: published.status === "abstained" ? published.reason : null,
    });
  } catch (error) {
    await finishReclassifyRun(db, created.id, [
      scrubErrorMessage(error instanceof Error ? error.message : String(error)),
    ]);
    throw error;
  }
}
