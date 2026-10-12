import type { emailClassificationObservationInput } from "@cubby/schemas/email-observations";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  selectDecisionModel,
  type SupportedDecisionModel,
} from "@cubby/shared/ai/models";
import type { z } from "zod";

import {
  decisionChoiceFitsContext,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import {
  MAILBOX_RELEVANCE_FEATURE,
  MAILBOX_TRIAGE_FEATURE,
} from "~/server/ai/features";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { paidResearchPreflight } from "~/server/runs/execution-transport";

import { gmailRelevanceAllowed } from "./execution-policy";
import type { MailRelevance } from "./relevance";
import { mailTriageChoices, mailTriagePrompt, type MailTriage } from "./triage";

export type GmailClassificationCall = Pick<
  z.output<typeof emailClassificationObservationInput>,
  "model" | "promptVersion" | "operation"
>;

type OnClassificationCall = (call: GmailClassificationCall) => void;

/** `decisionModel` pins Jev or Clef for a replay; omitted samples the trial split. */
export const productionMailTriage =
  (
    db: Database,
    runId: string,
    onCall?: OnClassificationCall,
    decisionModel?: SupportedDecisionModel,
  ): MailTriage =>
  async (subject) => {
    const prompt = mailTriagePrompt(subject);
    if (!decisionChoiceFitsContext(prompt)) return "uncertain";
    const model = decisionModel ?? selectDecisionModel();
    const result = await runDecisionChoice({
      ...prompt,
      feature: MAILBOX_TRIAGE_FEATURE,
      decisionModel: model,
      usage: {
        db,
        runId: runEntityId.parse(runId),
        operation: "mailbox-triage",
        beforePaidRequest: paidResearchPreflight(db, runEntityId.parse(runId)),
      },
    });
    onCall?.({
      model,
      promptVersion: MAILBOX_TRIAGE_FEATURE.promptVersion,
      operation: "mailbox-triage",
    });
    if (result.selectedIndex === null) return "uncertain";
    const choice = mailTriageChoices[result.selectedIndex] ?? "uncertain";
    return choice === "unrelated" && result.confidence !== "high"
      ? "uncertain"
      : choice;
  };

export const productionMailRelevance =
  (db: Database, runId: string, onCall?: OnClassificationCall): MailRelevance =>
  async (request) => {
    if (!(await gmailRelevanceAllowed(db, runId)))
      throw new Error(
        "Classification-only Gmail Runs cannot use the relevance model.",
      );
    const result = await runStructuredFeature(
      MAILBOX_RELEVANCE_FEATURE,
      request,
      {
        db,
        runId: runEntityId.parse(runId),
        operation: "mailbox-relevance",
        subscriptionRequired: true,
        subscriptionFallback: "budgeted",
        beforePaidRequest: paidResearchPreflight(db, runEntityId.parse(runId)),
      },
    );
    onCall?.({
      model: MAILBOX_RELEVANCE_FEATURE.model,
      promptVersion: MAILBOX_RELEVANCE_FEATURE.promptVersion,
      operation: "mailbox-relevance",
    });
    return result;
  };
