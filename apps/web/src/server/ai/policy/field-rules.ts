/**
 * ADR 0028's rules for one field of one record, as a pure function the
 * `fields` reconciler calls: Cubby acts when it can take the action back with
 * one write and no person has said otherwise.
 *
 * A person holds a field while an assignment decision is in force on it.
 * Without one, Cubby holds it: an empty field is open, a filled one is
 * Cubby's to revise. A value a person vetoed is never applied, and Cubby
 * clears it when it is the stored value.
 */
import type { SuggestApplyPolicy } from "@cubby/schemas/field-suggestion-policy";

/** The confidence at which Cubby saves an answer on its own. */
export const AUTOMATIC_BAR = 0.85;
/** A revision of Cubby's own value must beat the runner-up by this much. */
export const REPLACEMENT_MARGIN = 0.2;

export type FieldValue = string | number | boolean | null;

/** Cubby's answer for one field: the proposal, or null when it proposed nothing. */
export type FieldProposal = {
  value: string;
  label: string | null;
  confidence: number;
  runnerUp: { value: string; label: string | null; confidence: number } | null;
};

export type FieldInputs = {
  apply: SuggestApplyPolicy;
  fillOnly: boolean;
  /** The stored value. */
  current: FieldValue;
  /** Whether the stored value records no decision (blank, or the declared placeholder). */
  currentUndecided: boolean;
  /** An assignment decision is in force on the field. */
  personHolds: boolean;
  /** Values a person ruled out for this record and field. */
  vetoed: readonly string[];
  /** Values this field held before a later write replaced them. */
  replaced: readonly string[];
  proposal: FieldProposal | null;
};

export type FieldVerdict =
  | { kind: "keep"; reason: string }
  | { kind: "write"; value: FieldValue; reason: string }
  | { kind: "review"; proposal: FieldProposal };

/** A stored column value as JSON: the form an Ask input and a decision carry. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- reads any column value a row carries; every branch narrows it.
export function fieldJson(value: unknown): FieldValue | string[] {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((entry) => valueKey(entry));
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  return JSON.stringify(value);
}

/** Values compare by their text, so an id read from a row equals the same id in a decision. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- compares any column, decision or answer value.
export function valueKey(value: unknown): string {
  const json =
    value instanceof Date || typeof value === "bigint"
      ? fieldJson(value)
      : value;
  return typeof json === "string" ? json : JSON.stringify(json ?? null);
}

export function decideField(input: FieldInputs): FieldVerdict {
  const keep = (reason: string) => ({ kind: "keep" as const, reason });
  if (input.personHolds) return keep("A person holds this value");
  const vetoed = new Set(input.vetoed);
  const ruledOut =
    !input.currentUndecided && vetoed.has(valueKey(input.current));
  const empty = input.currentUndecided || ruledOut;
  const verdict = ((): FieldVerdict => {
    const proposal = input.proposal;
    if (!proposal) return keep("Cubby proposed no value");
    if (vetoed.has(valueKey(proposal.value)))
      return keep("A person ruled this value out");
    if (!empty && valueKey(proposal.value) === valueKey(input.current))
      return keep("Cubby's answer is the stored value");
    if (input.apply === "offer")
      return keep("Cubby's answer waits in the picker");
    if (proposal.confidence < AUTOMATIC_BAR)
      return keep("Cubby is not confident enough to act");
    if (input.apply === "review") return { kind: "review", proposal };
    if (!empty) {
      if (input.fillOnly)
        return keep("Other records inherit this field; Cubby only fills it");
      if (
        proposal.confidence - (proposal.runnerUp?.confidence ?? 0) <
        REPLACEMENT_MARGIN
      )
        return keep("A replacement must clearly beat the runner-up");
      if (input.replaced.includes(valueKey(proposal.value)))
        return keep("This field already held that value once");
    }
    return {
      kind: "write",
      value: proposal.value,
      reason: empty ? "Cubby filled an open field" : "Cubby revised its value",
    };
  })();
  if (ruledOut && input.apply === "auto" && verdict.kind === "keep")
    return { kind: "write", value: null, reason: "A person ruled this out" };
  return verdict;
}
