/**
 * How an owed answer reads once Cubby cannot produce it on its own (ADR 0029
 * section 8): an `unknown` ask, one out of attempts, or one a member gave up
 * on is a gap whose actor is the member. Its actions are decisions on the
 * ask's subject: `not_sent` returns an unknown ask to the queue, `retry`
 * re-queues one that failed or was given up, `abandoned` gives up.
 */
import type { KernelGap, KernelGapAction } from "@cubby/schemas/kernel/stage";

export const ASK_OUTCOME_FIELD = "outcome";
export const askOutcomes = ["not_sent", "retry", "abandoned"] as const;
export type AskOutcome = (typeof askOutcomes)[number];

/** The decision subject of an owed answer. */
const askSubject = (inputHash: string) => `ask:${inputHash}`;
export const askOfSubject = (subject: string) =>
  subject.startsWith("ask:") ? subject.slice("ask:".length) : null;

export type AskCondition = {
  inputHash: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  cancelled: boolean;
};

const action = (
  inputHash: string,
  value: AskOutcome,
  label: string,
): KernelGapAction => ({
  channel: "assignment",
  kind: "set",
  subject: askSubject(inputHash),
  field: ASK_OUTCOME_FIELD,
  value,
  label,
});

/** Whether the ask counts toward Stuck: unknown, or out of attempts, and not given up. */
export const askIsStuck = (ask: AskCondition) =>
  !ask.cancelled &&
  (ask.state === "unknown" ||
    (ask.state === "queued" && ask.attempts >= ask.maxAttempts));

/** The member's gap for an ask Cubby cannot settle alone; null while Cubby still can. */
export function askMemberGap(
  ask: AskCondition,
  label: string,
  since: string | null = null,
): KernelGap | null {
  const gap = (input: string, actions: KernelGapAction[]): KernelGap => ({
    kind: "answer",
    input,
    actor: "you",
    since,
    until: null,
    actions,
    inputHash: ask.inputHash,
  });
  if (ask.cancelled)
    return gap(`${label}, which was given up`, [
      action(ask.inputHash, "retry", "Ask again"),
    ]);
  if (ask.state === "unknown")
    return gap(`${label}: the request was sent and its outcome is unknown`, [
      action(ask.inputHash, "not_sent", "It was not sent: ask again"),
      action(ask.inputHash, "abandoned", "Give up on this answer"),
    ]);
  if (ask.state === "queued" && ask.attempts >= ask.maxAttempts)
    return gap(`${label}: failed ${ask.attempts} times`, [
      action(ask.inputHash, "retry", "Try again"),
      action(ask.inputHash, "abandoned", "Give up on this answer"),
    ]);
  return null;
}
