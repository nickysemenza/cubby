import { z } from "zod";

/**
 * A record's stage, in precedence order: the first that applies wins
 * (ADR 0029 section 10). Stage is never stored on a record; `ScopeState`
 * caches the last computed value for list filters and sorts, and the
 * reconciler's gaps stay the truth.
 */
export const kernelStage = z.enum([
  "ended",
  "stuck",
  "working",
  "needs_you",
  "waiting",
  "done",
]);
export type KernelStage = z.infer<typeof kernelStage>;

/**
 * Who supplies the next input: `you` (a member), `cubby`, `agent`, `time`, or
 * a named source as `source:<name>`. Stored as this text so SQL projections
 * filter and sort on it directly.
 */
const ACTOR_PATTERN = /^(?:you|cubby|agent|time|source:[^\s].{0,79})$/u;
export const kernelActor = z
  .string()
  .regex(ACTOR_PATTERN, "Unknown kernel actor");
export type KernelActor = z.infer<typeof kernelActor>;

export const sourceActor = (name: string): KernelActor =>
  kernelActor.parse(`source:${name}`);

/** What a gap waits for; `unsupported` is a record held by decisions alone. */
const kernelGapKind = z.enum([
  "evidence",
  "answer",
  "decision",
  "time",
  "unsupported",
]);

export const decisionChannel = z.enum([
  "assignment",
  "veto",
  "identity",
  "rejection",
]);
export type DecisionChannel = z.infer<typeof decisionChannel>;

/** Each channel's kinds; `release` names the channel it releases. */
export const DECISION_KINDS = {
  assignment: ["set", "none", "release"],
  veto: ["veto", "release"],
  identity: ["same", "distinct", "release"],
  rejection: ["reject", "release"],
} as const satisfies Record<DecisionChannel, readonly string[]>;
export const decisionKind = z.enum([
  "set",
  "none",
  "release",
  "veto",
  "same",
  "distinct",
  "reject",
]);

/** Who recorded a decision. */
export const decisionActorKind = z.enum(["member", "agent", "system"]);
export type DecisionActorKind = z.infer<typeof decisionActorKind>;
export type DecisionKind = z.infer<typeof decisionKind>;

/** A member action a gap offers: the decision it records and where. */
const kernelGapAction = z.object({
  channel: decisionChannel,
  kind: decisionKind,
  subject: z.string(),
  field: z.string().nullable(),
  /** The decision's value, for an action that sets one. */
  value: z.json().optional(),
  /** Member-facing label from the reconciler, worded by the server. */
  label: z.string(),
});
export type KernelGapAction = z.infer<typeof kernelGapAction>;

/** One missing input a reconciler declared, in its order. */
export const kernelGap = z.object({
  kind: kernelGapKind,
  /** Member-facing name of the missing input, worded by the server. */
  input: z.string(),
  actor: kernelActor,
  since: z.iso.datetime().nullable(),
  /** A `time` gap's instant; null otherwise. */
  until: z.iso.datetime().nullable(),
  actions: z.array(kernelGapAction),
  /** The ask an `answer` gap waits on. */
  inputHash: z.string().nullable(),
});
export type KernelGap = z.infer<typeof kernelGap>;

/**
 * The stage from a record's state, first match wins. `working` is read from a
 * live claim, never from the cache.
 */
export function resolveStage(state: {
  ended: boolean;
  stuck: boolean;
  working: boolean;
  gaps: readonly Pick<KernelGap, "kind" | "actor">[];
}): KernelStage {
  if (state.ended) return "ended";
  if (state.stuck) return "stuck";
  if (state.working) return "working";
  const first = state.gaps[0];
  if (!first) return "done";
  return first.actor === "you" || first.kind === "decision"
    ? "needs_you"
    : "waiting";
}

/** The next actor: the first gap's, or null when nothing is owed. */
export const nextActor = (
  gaps: readonly Pick<KernelGap, "actor">[],
): KernelActor | null => gaps[0]?.actor ?? null;
