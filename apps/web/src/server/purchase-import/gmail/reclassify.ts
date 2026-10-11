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
import {
  parseEntityId,
  parseShortcodeFor,
  type RunId,
} from "@cubby/schemas/identifiers";
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

import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../mail-source-identity";
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
 * A request's Reclassify stops starting Emails after this long and defers the
 * rest: MCP writes have a 230 s budget, and one Email (Gmail, Jev, relevance
 * model) can take most of a minute.
 */
const RECLASSIFY_TIME_BUDGET_MS = 150_000;

/** Backfill, else continuous; an expired or revoked approval is unusable, not fatal. */
async function mailboxApproval(
  db: Database,
  owner: { userId: ActorContext["userId"]; ledgerPartyId: string },
  mailboxId: string,
) {
  const refused: string[] = [];
  for (const kind of ["backfill", "continuous"] as const) {
    try {
      const ref = await latestExecutionAuthorization(
        db,
        {
          ...owner,
          ledgerPartyId: parseEntityId("ledgerParty", owner.ledgerPartyId),
        },
        mailboxId,
        kind,
      );
      if (ref) return ref;
    } catch (error) {
      refused.push(
        `${kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `Reclassify needs a usable Gmail execution approval for mailbox ${mailboxId}${refused.length ? ` (${refused.join("; ")})` : ""}.`,
  );
}

async function finishReclassifyRun(
  db: Database,
  runId: RunId,
  notes: readonly string[],
) {
  // A budget pause (`needs_review`) keeps its status and failure code.
  await getDb(db)
    .update(run)
    .set({
      status: "completed",
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
async function startReclassifyRun(
  db: Database,
  actor: ActorContext,
  mode: "relevance" | "preview",
  emails: readonly OwnedEmail[],
  executionAuthorization: Awaited<ReturnType<typeof mailboxApproval>>,
) {
  const [first] = emails;
  if (!first) throw new Error("Reclassify needs at least one Email.");
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
  if (created?.ledgerPartyId !== first.ledgerPartyId) {
    const message =
      "Reclassify Run owner differs from the Email owner; reclassify each member's Emails separately.";
    await finishReclassifyRun(db, runId, [message]);
    throw new Error(message);
  }
  return { id: runId, shortcode: created.shortcode };
}

/** What a rerun did to the Email, or null when publication declined it. */
function reclassifyOutcome(
  outcome: Awaited<ReturnType<typeof ingestGmailMessages>>,
  before: OwnedEmail,
  after: OwnedEmail | undefined,
): EmailReclassifyOutcome | null {
  if (outcome.deleted.length || outcome.excluded.length) return "removed";
  const kept = outcome.kept[0];
  if (kept) return kept.reason;
  if (
    outcome.confirmed.length ||
    outcome.saved.length ||
    outcome.unrelated.length ||
    outcome.blocked.length
  )
    return after?.classification === before.classification
      ? "confirmed"
      : "replaced";
  return null;
}

async function reclassifyOne(
  db: Database,
  provider: Awaited<ReturnType<typeof gmailProviderForUser>>,
  email: OwnedEmail,
  runId: RunId,
  ports: IngestPorts,
) {
  const outcome = await ingestGmailMessages(db, provider, {
    ...ports,
    ledgerPartyId: email.ledgerPartyId,
    mailboxId: email.mailboxId,
    messageIds: [email.messageId],
    runId,
    reclassify: true,
  });
  const [[observed], [after]] = await Promise.all([
    getDb(db)
      .select()
      .from(emailClassificationObservation)
      .where(
        and(
          eq(emailClassificationObservation.emailId, email.id),
          eq(emailClassificationObservation.runId, runId),
        ),
      )
      .orderBy(desc(emailClassificationObservation.createdAt))
      .limit(1),
    getDb(db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, email.id))
      .limit(1),
  ]);
  const declined = (await deferClassificationRefresh(
    db,
    "classification_only",
    after ?? null,
  ))
    ? "frozen"
    : "changed";
  return {
    outcome: reclassifyOutcome(outcome, email, after) ?? declined,
    classification: observed?.classification ?? null,
    stage: observed?.stage ?? null,
    conflict: observed?.conflict?.kind === "member_review",
  };
}

/** Rerun Relevance for selected Emails from their Gmail originals. */
export async function reclassifyEmails(
  db: Database,
  rawInput: ReclassifyEmailsInput,
  actor: ActorContext,
  {
    timeBudgetMs = RECLASSIFY_TIME_BUDGET_MS,
    ...ports
  }: IngestPorts & { timeBudgetMs?: number } = {},
): Promise<ReclassifyEmailsOut> {
  const started = Date.now();
  const input = reclassifyEmailsInput.parse(rawInput);
  const emails = await ownedEmails(db, [...new Set(input.ids)], actor);
  const groups = Object.values(
    groupBy(
      emails,
      (email) => `${email.ledgerPartyId}\u0000${email.mailboxId}`,
    ),
  );
  // Every mailbox's approval is settled before any Run or Gmail read.
  const batches = await Promise.all(
    groups.map(async (group) => ({
      group,
      approval: await mailboxApproval(
        db,
        { userId: actor.userId, ledgerPartyId: group[0]!.ledgerPartyId },
        group[0]!.mailboxId,
      ),
    })),
  );
  const results: ReclassifyEmailsOut["results"] = [];
  const runIds: string[] = [];
  let reached = 0;
  for (const { group, approval } of batches) {
    const created = await startReclassifyRun(
      db,
      actor,
      "relevance",
      group,
      approval,
    );
    runIds.push(created.shortcode);
    const notes: string[] = [];
    let provider: Awaited<ReturnType<typeof gmailProviderForUser>> | null =
      null;
    try {
      for (const email of group) {
        const result = {
          id: parseShortcodeFor("email", email.shortcode),
          classification: null,
          stage: null,
          conflict: false,
          error: null,
        };
        // Always make progress; past the budget, defer the rest to a rerun.
        if (reached > 0 && Date.now() - started > timeBudgetMs) {
          results.push({ ...result, outcome: "deferred" });
          notes.push(`${email.shortcode}: deferred past the time budget`);
          continue;
        }
        reached += 1;
        try {
          // Ingest blocks both before classifying; neither changes Relevance.
          if (
            email.classificationVersion ===
              HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION ||
            (await deferClassificationRefresh(db, "classification_only", email))
          ) {
            results.push({ ...result, outcome: "frozen" });
            continue;
          }
          provider ??= await gmailProviderForUser(
            db,
            actor.userId,
            email.mailboxId,
          );
          results.push({
            ...result,
            ...(await reclassifyOne(db, provider, email, created.id, ports)),
          });
        } catch (error) {
          const message = scrubErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
          notes.push(`${email.shortcode}: ${message}`);
          results.push({ ...result, outcome: "failed", error: message });
        }
      }
    } finally {
      await finishReclassifyRun(db, created.id, notes);
    }
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
  const created = await startReclassifyRun(
    db,
    actor,
    "preview",
    [email],
    await mailboxApproval(
      db,
      { userId: actor.userId, ledgerPartyId: email.ledgerPartyId },
      email.mailboxId,
    ),
  );
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
