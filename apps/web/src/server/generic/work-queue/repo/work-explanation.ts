import { runShortcode } from "@cubby/schemas/identifiers";
import type { runStatus } from "@cubby/schemas/run-fields";
import type { WorkExplanation, WorkQueueRow } from "@cubby/schemas/work-queue";
import type { z } from "zod";

import { workExecutor } from "./work-routing";

export function workRunLifecycle(
  status: z.infer<typeof runStatus>,
): WorkExplanation["lifecycle"] {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "dispatch_failed":
      return "failed";
    case "paused":
    case "paused_auth":
    case "paused_offline":
    case "paused_approval":
    case "needs_review":
      return "paused";
  }
}

/** Explanations describe current evidence, never grant execution authority. */
export type WorkContext = Partial<
  Pick<
    WorkExplanation,
    | "lifecycle"
    | "prerequisites"
    | "effects"
    | "unblocks"
    | "readiness"
    | "reason"
  >
>;

export function projectWorkExplanations(
  row: WorkQueueRow,
  context: WorkContext = {},
): WorkExplanation[] {
  const record =
    row.entity && row.id ? { entity: row.entity, id: row.id } : null;
  const prerequisites: WorkExplanation["prerequisites"] = [
    ...(context.prerequisites ?? []),
  ];
  if (row.waitingFor.kind === "unresolved")
    prerequisites.push({
      code: "source_authority",
      state: "missing",
      reason: row.waitingFor.reason,
      record,
    });
  if (row.kind === "awaiting_posting")
    prerequisites.push({
      code: "posting",
      state: "missing",
      reason: "The financial provider must post the transaction.",
      record,
    });
  const actions =
    row.gaps.length > 0
      ? row.gaps.map((gap) => ({
          key: `${row.key}:${gap.check}`,
          label: gap.message,
          reason: gap.message,
        }))
      : [{ key: row.key, label: row.nextAction, reason: row.reason }];
  const executor = workExecutor(row);
  return actions.map((action) => ({
    ...action,
    reason: context.reason ?? action.reason,
    category: row.kind,
    readiness:
      prerequisites.length > 0
        ? "blocked"
        : (context.readiness ??
          (executor === "agent_session" || executor === "human"
            ? "ready"
            : "unknown")),
    lifecycle: context.lifecycle ?? "open",
    executor,
    authority: row.waitingFor,
    prerequisites,
    effects:
      context.effects ??
      (row.kind === "research"
        ? {
            certainty: "partial",
            changes: [
              {
                action: "change",
                record,
                description:
                  "Record verified facts or a supported data exception. Review the proposed fields before applying.",
              },
            ],
          }
        : { certainty: "unknown", changes: [] }),
    unblocks: action.key.endsWith(":vendor_logo")
      ? []
      : (context.unblocks ?? []),
    runs:
      row.entity === "run" && row.id
        ? [{ id: runShortcode.parse(row.id), relation: "execution" }]
        : [],
  }));
}
