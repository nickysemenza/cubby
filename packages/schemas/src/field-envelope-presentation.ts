import type { EntityFieldModel } from "./entity-fields";
import type { KernelActor, KernelStage } from "./kernel/stage";
import { z } from "zod";
import {
  fieldDecisionOf,
  fieldValueOf,
  type ReadableFieldEnvelope,
} from "./field-envelope";

type Labels = NonNullable<
  NonNullable<EntityFieldModel["fields"][number]["resolution"]>["labels"]
>;
type Envelope = Pick<ReadableFieldEnvelope, "result">;
type Policy = EntityFieldModel["fields"][number]["resolution"];

/** Twin of Swift `FieldAssignmentAction.setNoneLabel(_:)`. */
export function fieldSetNoneLabel(policy: NonNullable<Policy>): string {
  return `Set to ${policy.labels?.none ?? "none"}`;
}

/** Twin of Swift `FieldEnvelope.missingLabel`: a value Cubby has not worked out yet. */
export function fieldMissingLabel(): string {
  return FIELD_WAITING_LABEL;
}

/** The one missing-value phrase: a computed value Cubby has not published yet. */
export const FIELD_WAITING_LABEL = "Waiting for Cubby";
/** Appended to a published value whose inputs changed since it was worked out. */
export const FIELD_STALE_LABEL = "out of date";
/** The one reset action: release the field so Cubby or inheritance decides it. */
export const FIELD_RESET_LABEL = "Let Cubby decide";
/** The veto on a value Cubby set. */
export const FIELD_VETO_LABEL = "Wrong, clear it";

/** Twin of Swift `FieldEnvelope.noneLabel(field:)`. */
function fieldNoneLabel(labels?: Labels | null): string {
  return labels?.none ?? "None";
}

/** Twin of Swift `FieldEnvelope.label(for:field:)`. */
export function fieldEmptyLabel(
  envelope: Envelope,
  labels?: Labels | null,
): string | null {
  const decision = fieldDecisionOf(envelope);
  if (!decision) return fieldMissingLabel();
  if (decision.outcome.kind === "value") return null;
  switch (decision.outcome.reason) {
    case "explicit_none":
      return fieldNoneLabel(labels);
    case "unset":
      return decision.provenance?.kind === "allocated"
        ? "Allocated"
        : (labels?.unresolved ?? "Not set");
    case "blocked":
      return "Blocked";
    case "mixed":
      return "Mixed";
    case "not_applicable":
      return "Not applicable";
  }
}

/** Twin of Swift `FieldEnvelope.visibleEmptyLabel(field:)`. */
export function fieldVisibleEmptyLabel(
  envelope: Envelope,
  labels?: Labels | null,
): string | null {
  const decision = fieldDecisionOf(envelope);
  if (
    decision?.outcome.kind === "empty" &&
    decision.outcome.reason === "unset" &&
    labels?.unresolved == null
  )
    return null;
  return fieldEmptyLabel(envelope, labels);
}

/** Twin of Swift `FieldEnvelope.actions(field:)`. */
export function fieldAssignmentActions(
  envelope: ReadableFieldEnvelope,
  policy: Policy | undefined,
  fieldKey: string,
) {
  const { assignment, controls } = envelope.current;
  if (!policy || controls.kind !== "editable") return [];
  if (assignment !== null) {
    switch (assignment.kind) {
      case "inherit":
      case "none":
        break;
      case "value":
        if (
          assignment.ownership.kind !== "record" &&
          assignment.ownership.kind !== "automatic"
        )
          return [];
        break;
      default:
        return [];
    }
  }
  if (
    controls.reset.kind !== "available" &&
    controls.reset.kind !== "unavailable"
  )
    return [];
  const actions: Array<{
    kind: "use-inherited" | "keep-value" | "set-none";
    label: string;
    patch: NonNullable<Policy>["reset"];
  }> = [];
  if (
    controls.reset.kind === "available" &&
    Object.keys(policy.reset).length > 0
  )
    actions.push({
      kind: "use-inherited",
      label: FIELD_RESET_LABEL,
      patch: policy.reset,
    });
  const value = fieldValueOf(envelope);
  if (policy.confirm && controls.canConfirm && value !== null)
    actions.push({
      kind: "keep-value",
      label: "Keep this value",
      patch: { ...policy.confirm, [fieldKey]: z.json().parse(value) },
    });
  if (policy.none && controls.canSetNone && assignment?.kind !== "none")
    actions.push({
      kind: "set-none",
      label: fieldSetNoneLabel(policy),
      patch: policy.none,
    });
  return actions;
}

const KERNEL_STAGE_LABEL = {
  ended: "Ended",
  stuck: "Stuck",
  working: "Working",
  needs_you: "Needs you",
  waiting: "Waiting",
  done: "Done",
} as const satisfies Record<KernelStage, string>;

/** @public Member-facing stage name for the machinery panel; no client derives or humanizes a stage. */
export function kernelStageLabel(stage: KernelStage): string {
  return KERNEL_STAGE_LABEL[stage];
}

/** @public Member-facing actor name for the machinery panel; a source actor carries its own display name. */
export function kernelActorLabel(actor: KernelActor): string {
  switch (actor) {
    case "you":
      return "you";
    case "cubby":
      return "Cubby";
    case "agent":
      return "an agent";
    case "time":
      return "time";
    default:
      return actor.slice("source:".length);
  }
}

/**
 * @public The machinery panel's stage line.
 *
 * The stage line: `{Stage} · {waiting|working} for {input} from {actor}`,
 * then queue position and ETA when the actor is a queue or time.
 */
export function kernelStageLine(line: {
  stage: KernelStage;
  input: string | null;
  actor: KernelActor | null;
  queue?: { position: number; of: number; eta: string | null } | null;
}): string {
  const stage = kernelStageLabel(line.stage);
  if (!line.input || !line.actor) return stage;
  const mode = line.stage === "working" ? "working" : "waiting";
  const base = `${stage} · ${mode} for ${line.input} from ${kernelActorLabel(line.actor)}`;
  if (!line.queue) return base;
  const position = `${line.queue.position} of ${line.queue.of} in line`;
  return line.queue.eta
    ? `${base} · ${position} · expected by ${line.queue.eta}`
    : `${base} · ${position}`;
}

/** A machinery panel row's status: always a visible word, never a colour alone. */
export type MachineryRowStatus =
  | "used"
  | "skipped"
  | "gap"
  | "blocked"
  | "failed";

const MACHINERY_ROW_STATUS_LABEL = {
  used: "Used",
  skipped: "Skipped",
  gap: "Gap",
  blocked: "Blocked",
  failed: "Failed",
} as const satisfies Record<MachineryRowStatus, string>;

/** @public Twin of Swift `MachineryRow.statusLabel`. */
export function machineryRowStatusLabel(status: MachineryRowStatus): string {
  return MACHINERY_ROW_STATUS_LABEL[status];
}

/**
 * @public An input's row status: a decided input was used; an answer with a
 * raw error and no model failed.
 */
export function machineryInputRowStatus(input: {
  status: "decided" | "skipped" | "gap" | "blocked";
  answer: { rawError: string | null; model: string | null } | null;
}): MachineryRowStatus {
  if (input.status === "decided") return "used";
  if (input.answer?.rawError && input.answer.model === null) return "failed";
  return input.status;
}

const MACHINERY_INPUT_KIND_LABEL = {
  evidence: "Evidence",
  answer: "Answer",
  decision: "Decision",
  default: "Default",
} as const;

/** @public Twin of Swift `MachineryRow.kindLabel`. */
export function machineryInputKindLabel(
  kind: keyof typeof MACHINERY_INPUT_KIND_LABEL,
): string {
  return MACHINERY_INPUT_KIND_LABEL[kind];
}

const DECISION_KIND_LABEL = {
  set: "Set",
  none: "Set to none",
  release: "Released",
  veto: "Vetoed",
  same: "Same record",
  distinct: "Different records",
  reject: "Rejected",
} as const;
const DECISION_CHANNEL_LABEL = {
  assignment: "Assignment",
  veto: "Veto",
  identity: "Identity",
  rejection: "Rejection",
} as const;

/** @public Twin of Swift `MachineryDecision.kindLabel`. */
export function decisionKindLabel(
  kind: keyof typeof DECISION_KIND_LABEL,
): string {
  return DECISION_KIND_LABEL[kind];
}

/** @public Twin of Swift `MachineryDecision.channelLabel`. */
export function decisionChannelLabel(
  channel: keyof typeof DECISION_CHANNEL_LABEL,
): string {
  return DECISION_CHANNEL_LABEL[channel];
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** @public Micro-dollars as the panel's cost: "$0.004", "$1.20", "$0". */
export function machineryCostLabel(micros: number): string {
  if (micros === 0) return "$0";
  const dollars = micros / 1_000_000;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${Number(dollars.toPrecision(2))}`;
}

/**
 * @public The detail header's count line, which opens the panel:
 * "3 inputs · 2 asks · 1 decision · $0.004". Evidence and defaults are
 * inputs, answers are asks; a capped collection adds "+".
 */
export function machineryCountLine(read: {
  inputs: {
    items: readonly { kind: "evidence" | "answer" | "decision" | "default" }[];
    shown: number;
    total: number;
  };
  totalCostMicros: number;
}): string {
  const count = (kinds: readonly string[]) =>
    read.inputs.items.filter((input) => kinds.includes(input.kind)).length;
  const more = read.inputs.total > read.inputs.shown ? "+" : "";
  return [
    plural(count(["evidence", "default"]), "input", "inputs") + more,
    plural(count(["answer"]), "ask", "asks"),
    plural(count(["decision"]), "decision", "decisions"),
    machineryCostLabel(read.totalCostMicros),
  ].join(" · ");
}

/** @public The first gap as one sentence: "Waiting for a receipt from Amazon." */
export function machineryGapSentence(gap: {
  input: string;
  actor: KernelActor;
}): string {
  return `Waiting for ${gap.input} from ${kernelActorLabel(gap.actor)}.`;
}

/** @public A queue's estimate, or "ETA unknown" with too little history. */
export function machineryEtaLabel(formattedEta: string | null): string {
  return formattedEta === null ? "ETA unknown" : `expected by ${formattedEta}`;
}

/** @public "Attempt 2 of 5", with the next try when one is scheduled. */
export function machineryAttemptsLabel(
  attempts: { n: number; max: number },
  formattedNextAt: string | null,
): string {
  const base = `Attempt ${attempts.n} of ${attempts.max}`;
  return formattedNextAt ? `${base} · next try ${formattedNextAt}` : base;
}

/** @public "Showing 50 of 120" when a collection was capped; null when complete. */
export function machineryCoverageLabel(collection: {
  shown: number;
  total: number;
}): string | null {
  return collection.total > collection.shown
    ? `Showing ${collection.shown} of ${collection.total}`
    : null;
}

/** @public An unknown paid call: Cubby cannot tell whether it went through. */
export const MACHINERY_UNKNOWN_CALL_NOTE =
  "Cubby can't tell whether this paid call went through, so it won't send it again on its own.";
/** @public The header's second line when nothing is owed. */
export const MACHINERY_NO_GAP_LABEL = "Nothing is waiting on this.";
/** @public The empty panel. */
export const MACHINERY_EMPTY_LABEL = "Cubby has recorded no work on this yet.";

/**
 * @public A field's deciding level in the field scope's shared words: "From
 * {source}", "Set by {you / name}", "Set to none by {actor}", "Worked out by
 * Cubby", "Waiting for {input} from {actor}".
 */
export function fieldDecidingLine(
  level:
    | { kind: "source"; source: string }
    | { kind: "set"; by: string }
    | { kind: "none"; by: string }
    | { kind: "cubby" }
    | { kind: "waiting"; input: string; actor: KernelActor },
): string {
  switch (level.kind) {
    case "source":
      return `From ${level.source}`;
    case "set":
      return `Set by ${level.by}`;
    case "none":
      return `Set to none by ${level.by}`;
    case "cubby":
      return "Worked out by Cubby";
    case "waiting":
      return `Waiting for ${level.input} from ${kernelActorLabel(level.actor)}`;
  }
}

const MACHINERY_LIST_COLUMN_LABEL = {
  stage: "Stage",
  actor: "Actor",
  gap: "Gap",
  attempts: "Attempts",
  cost: "Cost",
  eta: "ETA",
} as const;

/** @public The declared machinery list columns' headers. */
export function machineryColumnLabel(
  column: keyof typeof MACHINERY_LIST_COLUMN_LABEL,
): string {
  return MACHINERY_LIST_COLUMN_LABEL[column];
}
