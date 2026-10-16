import { runEntityId } from "@cubby/schemas/identifiers";
import { selectDecisionModel } from "@cubby/shared/ai/models";

import {
  decisionChoiceFitsContext,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import {
  MAILBOX_TRIAGE_FEATURE,
  type AiDecisionFeature,
} from "~/server/ai/policy/features";
import type { Database } from "~/server/db";
import { readCandidateOwnerEmail } from "~/server/domains/purchase-import/repo/gmail/candidate-source";
import { paidResearchPreflight } from "~/server/domains/run/service/execution-transport";

import { gmailExecutionPolicy } from "../../repo/gmail/execution-policy";
import type { EmailCandidateChoice } from "./candidate-extraction";

const MAILBOX_ORDER_CANDIDATE_FEATURE = {
  ...MAILBOX_TRIAGE_FEATURE,
  feature: "mailbox-order-candidate",
  promptVersion: "2026-10-10.1",
} satisfies AiDecisionFeature;

export async function productionCandidateChoice(
  db: Database,
  runId: string,
  input: { emailId: string; ledgerPartyId: string },
) {
  const email = await readCandidateOwnerEmail(db, input);
  if (!email) throw new Error("Email candidate owner is unavailable");
  await gmailExecutionPolicy(db, runId, email);
  const model = selectDecisionModel();
  let requested = false;
  const choose: EmailCandidateChoice = async (prompt) => {
    if (!decisionChoiceFitsContext(prompt))
      return {
        selectedIndex: null,
        confidence: "high",
        probability: 0,
        ranked: [],
      };
    requested = true;
    return runDecisionChoice({
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
