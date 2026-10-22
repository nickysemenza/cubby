import { assessmentFamily } from "@cubby/schemas/assessment";
import { runShortcode } from "@cubby/schemas/identifiers";
import { runStepErrors, runStepState } from "@cubby/schemas/run-step";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

/** One stored RunStep; `meta` stays raw so the view model owns its reading. */
const runDetailStep = z.object({
  key: z.string(),
  label: z.string(),
  position: z.number().int(),
  state: runStepState,
  found: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** `found − done − failed − skipped − removed`; null outside count mode. */
  left: z.number().int().nonnegative().nullable(),
  pages: z.number().int().nonnegative(),
  pausedReason: z.string().nullable(),
  pausedUntil: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  errors: runStepErrors,
  meta: z.json().nullable(),
});
export type RunDetailStep = z.infer<typeof runDetailStep>;

const runDetailStepsOut = z.object({
  purpose: z.string(),
  status: z.string(),
  steps: z.array(runDetailStep),
});
export type RunDetailStepsOut = z.infer<typeof runDetailStepsOut>;

/** Assessments a Run published in one family, newest first, bounded. */
export const RUN_DECISION_LIMIT = 500;
/** AssessmentState's stored statuses (`resolved`: answered without applying). */
export const runDecisionStatus = z.enum([
  "pending",
  "applied",
  "rejected",
  "superseded",
  "resolved",
]);
export type RunDecisionStatus = z.infer<typeof runDecisionStatus>;
const runDecision = z.object({
  id: z.uuid(),
  family: assessmentFamily,
  status: runDecisionStatus,
  /** False once a later publication replaced it. */
  active: z.boolean(),
  /** The family's stored judgment; the family's presenter parses it. */
  judgment: z.json(),
  producer: z
    .object({
      kind: z.string(),
      model: z.string().nullable(),
      revision: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RunDecision = z.infer<typeof runDecision>;

const runDecisionsOut = z.object({
  rows: z.array(runDecision),
  total: z.number().int().nonnegative(),
});
export type RunDecisionsOut = z.infer<typeof runDecisionsOut>;

export const runDetailContract = defineContract("runDetail", {
  steps: query({
    mcp: { omit: "client_view" },
    input: z.strictObject({ runId: runShortcode }),
    output: runDetailStepsOut,
    cache: { tags: [["run"]], profile: "live-status" },
  }),
  decisions: query({
    mcp: { omit: "client_view" },
    input: z.strictObject({ runId: runShortcode, family: assessmentFamily }),
    output: runDecisionsOut,
    cache: { tags: [["run"], ["suggestions"]] },
  }),
});
