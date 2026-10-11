import type { EmailCandidateSource } from "@cubby/schemas/email-candidates";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { selectDecisionModel } from "@cubby/shared/ai/models";
import { and, eq, isNull } from "drizzle-orm";

import {
  MAILBOX_TRIAGE_FEATURE,
  type AiDecisionFeature,
} from "~/server/ai/features";
import { jevChoiceFitsContext, runJevChoice } from "~/server/ai/jev";
import type { Database } from "~/server/db";
import { email as emailTable, orderMail } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { retainedMailJoin } from "~/server/repo/retained-mail";
import { paidResearchPreflight } from "~/server/runs/execution-transport";

import type { EmailCandidateChoice } from "./candidate-extraction";
import { gmailExecutionPolicy } from "./execution-policy";

const MAILBOX_ORDER_CANDIDATE_FEATURE = {
  ...MAILBOX_TRIAGE_FEATURE,
  feature: "mailbox-order-candidate",
  promptVersion: "2026-10-10.1",
  sample: true,
} satisfies AiDecisionFeature;

/** Exact member, provider identity and retained bytes own this read-only evidence. */
export async function loadCandidateSource(
  db: Database,
  input: { emailId: string; ledgerPartyId: string },
): Promise<EmailCandidateSource> {
  const [row] = await getDb(db)
    .select({ email: emailTable, original: orderMail })
    .from(emailTable)
    .innerJoin(orderMail, retainedMailJoin)
    .where(
      and(
        eq(emailTable.id, parseEntityId("email", input.emailId)),
        eq(
          emailTable.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(emailTable.provider, "gmail"),
        eq(emailTable.classification, "related"),
        isNull(emailTable.contentClearedAt),
        notDeleted(emailTable),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error(
      "Email candidate original is unavailable or outside its owner",
    );
  return {
    sourceKey: `${row.email.provider}:${row.email.mailboxId}:${row.email.messageId}`,
    checksum: row.email.checksum,
    content:
      row.original.content.bodyHtml ?? row.original.content.bodyText ?? "",
  };
}
export async function productionCandidateChoice(
  db: Database,
  runId: string,
  input: { emailId: string; ledgerPartyId: string },
) {
  const [email] = await getDb(db)
    .select()
    .from(emailTable)
    .where(
      and(
        eq(emailTable.id, parseEntityId("email", input.emailId)),
        eq(
          emailTable.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
      ),
    )
    .limit(1);
  if (!email) throw new Error("Email candidate owner is unavailable");
  await gmailExecutionPolicy(db, runId, email);
  const model = selectDecisionModel();
  let requested = false;
  const choose: EmailCandidateChoice = async (prompt) => {
    if (!jevChoiceFitsContext(prompt))
      return {
        selectedIndex: null,
        confidence: "high",
        probability: 0,
        ranked: [],
      };
    requested = true;
    return runJevChoice({
      ...prompt,
      feature: MAILBOX_ORDER_CANDIDATE_FEATURE,
      decisionModel: model,
      usage: {
        db,
        runId: runEntityId.parse(runId),
        operation: "mailbox-order-candidate",
        beforePaidRequest: paidResearchPreflight(db, runEntityId.parse(runId)),
      },
    });
  };
  return {
    choose,
    model,
    promptVersion: MAILBOX_ORDER_CANDIDATE_FEATURE.promptVersion,
    didRequest: () => requested,
  };
}
