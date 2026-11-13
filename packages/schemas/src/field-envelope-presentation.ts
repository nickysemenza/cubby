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

/** Twin of Swift `FieldEnvelope.missingLabel`. */
export function fieldMissingLabel(): string {
  return "Updating…";
}

/** Twin of Swift `FieldEnvelope.noneLabel(field:)`. */
export function fieldNoneLabel(labels?: Labels | null): string {
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
      label: "Use inherited",
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
