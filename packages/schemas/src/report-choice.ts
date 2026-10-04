import type { z } from "zod";

import type { CommitPreparedRequest, ReportChoice } from "./entity-report";
import { preparedProductResolution } from "./purchase-import";
import { tradeSchema } from "./task-fields";

/**
 * What the person has answered for a report's choices. Pure logic shared by the web form and
 * pinned for native by the same cases in CubbyKit's `ReportChoiceAnswersTests`: the server says
 * which choices exist and which are required, a client only records answers and asks whether
 * each is complete.
 */
export interface ChoiceAnswer {
  /** One of the choice's option ids. */
  optionId: string;
  /** The record picked, for an option that asks for one. */
  pickId?: string | undefined;
  /** The reason written, for an option that asks for one. */
  text?: string | undefined;
}
export type ChoiceAnswers = Readonly<Record<string, ChoiceAnswer | undefined>>;

export interface CommitPreparedInput {
  runId: CommitPreparedRequest["runId"];
  operationId: string;
  prepareOperationId: string;
  defaultTrade?: z.infer<typeof tradeSchema>;
  resolutions: Array<{
    stableOrderId: string;
    stableLineId: string;
    resolution: z.infer<typeof preparedProductResolution>;
  }>;
}

/** Whether `answer` names one of the choice's options and gives everything that option asks for. */
export function isChoiceAnswered(
  choice: ReportChoice,
  answer: ChoiceAnswer | undefined,
): boolean {
  const option = choice.options.find((entry) => entry.id === answer?.optionId);
  if (!option || !answer) return false;
  if (option.pick && !answer.pickId?.trim()) return false;
  if (option.text && !answer.text?.trim()) return false;
  return true;
}

/** How many required choices still lack a complete answer. */
export function remainingChoices(
  choices: readonly ReportChoice[],
  answers: ChoiceAnswers,
): number {
  return choices.filter(
    (choice) =>
      choice.required && !isChoiceAnswered(choice, answers[choice.id]),
  ).length;
}

/** "2 Product decisions remaining." */
export function remainingSentence(noun: string, remaining: number): string {
  return `${remaining} ${noun}${remaining === 1 ? "" : "s"} remaining.`;
}

/**
 * The exact `run.commitPrepared` body for the answers given, or null while any line's decision
 * or the batch's trade is missing or invalid. `operationId` is the idempotency key: a client
 * makes a fresh one whenever an answer changes and reuses it to retry the same answers, because
 * the server rejects a replayed id carrying different input.
 */
export function commitPreparedInput(
  request: CommitPreparedRequest,
  answers: ChoiceAnswers,
  operationId: string,
): CommitPreparedInput | null {
  let defaultTrade: ReturnType<typeof tradeSchema.parse> | undefined;
  if (request.tradeChoiceId !== null) {
    const trade = tradeSchema.safeParse(
      answers[request.tradeChoiceId]?.optionId,
    );
    if (!trade.success) return null;
    defaultTrade = trade.data;
  }
  const resolutions = [];
  for (const line of request.lines) {
    const answer = answers[line.choiceId];
    if (!answer) return null;
    const resolution = preparedProductResolution.safeParse(
      answer.optionId === "existing"
        ? { kind: "existing", productId: answer.pickId }
        : answer.optionId === "unresolved"
          ? { kind: "unresolved", reason: answer.text }
          : { kind: answer.optionId },
    );
    if (!resolution.success) return null;
    resolutions.push({
      stableOrderId: line.stableOrderId,
      stableLineId: line.stableLineId,
      resolution: resolution.data,
    });
  }
  const input: CommitPreparedInput = {
    runId: request.runId,
    operationId,
    prepareOperationId: request.prepareOperationId,
    resolutions,
  };
  if (defaultTrade) input.defaultTrade = defaultTrade;
  return input;
}
