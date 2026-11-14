import type { KernelGap } from "@cubby/schemas/kernel/stage";

/**
 * The member gap of a scope whose accepted baseline holds a proposed change
 * (ADR 0029 section 11). The held apply and the version sweep both write it
 * with the Drift proposal, so stage, Needs you and the badge show the change.
 */
export const heldBaselineGap = (): KernelGap => ({
  kind: "decision",
  input: "approval of the change to accepted records",
  actor: "you",
  since: null,
  until: null,
  actions: [],
  inputHash: null,
});
