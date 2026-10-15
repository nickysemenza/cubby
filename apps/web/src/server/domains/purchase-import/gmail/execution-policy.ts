import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import {
  emailExecutionPolicy,
  type EmailExecutionPolicy,
} from "@cubby/schemas/email-fields";
import { runEntityId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
import { isAiRefreshMailRun } from "@cubby/schemas/run-fields";
import {
  isMailReclassifyRun,
  mailReclassifyRunInput,
} from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { currentRunEvaluation } from "~/server/domains/run/service/execution-context";

/** Caller options cannot elevate a missing or classification-only persisted Run. */
export async function gmailExecutionPolicy(
  db: Database,
  runId?: string,
  expected?: {
    ledgerPartyId: string;
    mailboxId: string;
    evaluation?: { id: string; token: string };
  },
): Promise<EmailExecutionPolicy> {
  if (!runId) return "classification_only";
  const [current] = await getDb(db)
    .select()
    .from(run)
    .where(and(eq(run.id, runEntityId.parse(runId)), notDeleted(run)))
    .limit(1);
  const evaluation =
    expected?.evaluation ?? (current && currentRunEvaluation(current.id));
  const sharedExecutable =
    current &&
    evaluation &&
    (await (
      await import("~/server/ai/repo/ai-evaluation-requests")
    ).evaluationIsExecutable(db, evaluation, current.id));
  if (
    !current ||
    current.retiredAt ||
    (current.status !== "running" && !sharedExecutable)
  )
    throw new Error("Gmail classification Run is no longer executable.");
  if (expected && current.ledgerPartyId !== expected.ledgerPartyId)
    throw new Error("Gmail classification Run belongs to a different member.");
  if (current.purpose === "mail_discovery") {
    const input = mailboxDiscoveryInput.parse(current.input);
    if (expected && input.mailboxId !== expected.mailboxId)
      throw new Error(
        "Gmail classification mailbox is outside its persisted Run.",
      );
    return emailExecutionPolicy.parse(input.executionPolicy);
  }
  if (current.purpose === "mail_import") return "import";
  if (isAiRefreshMailRun(current)) {
    const input = aiRefreshRunInput.parse(current.input);
    if (expected && input.mailboxId !== expected.mailboxId)
      throw new Error("AI refresh mailbox is outside its persisted Run");
    return "classification_only";
  }
  const reclassify = mailReclassifyRunInput.safeParse(current.input);
  if (isMailReclassifyRun(current) && reclassify.success) {
    if (expected && reclassify.data.mailboxId !== expected.mailboxId)
      throw new Error(
        "Gmail classification mailbox is outside its persisted Run.",
      );
    // Reclassify reruns stages; it never authorizes import.
    return "classification_only";
  }
  throw new Error(
    "Gmail classification requires a Mail discovery, Mail import or Reclassify Run.",
  );
}

/** The relevance model runs for import-authorized work and for a member's Reclassify. */
export async function gmailRelevanceAllowed(db: Database, runId: string) {
  if ((await gmailExecutionPolicy(db, runId)) === "import") return true;
  const [current] = await getDb(db)
    .select({ purpose: run.purpose, input: run.input })
    .from(run)
    .where(eq(run.id, runEntityId.parse(runId)))
    .limit(1);
  return (
    current !== undefined &&
    (isMailReclassifyRun(current) || isAiRefreshMailRun(current))
  );
}
