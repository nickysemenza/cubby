import type { PhotoRunImage } from "@cubby/schemas/photo-import-run";
import type { FlueConversationMessage } from "@flue/sdk";

import type { RunDetail } from "~/contracts/run.contract";
export { formatDuration as formatWorkDuration } from "~/lib/format-duration";

type WorkKind =
  | "photo-context"
  | "photo-analysis"
  | "image-description"
  | "image-description-reused"
  | "catalog"
  | "records"
  | "photo-groups"
  | "product-match"
  | "purchase-review"
  | "purchase-import"
  | "photo-commit"
  | "photo-review";

export type AgentWorkItem = {
  kind: WorkKind;
  label: string;
  completed: number;
  failed: number;
  running: number;
  durationMs: number | null;
  timing: "tool" | "elapsed";
  /** Photo processing only: sum of executor attempt intervals. */
  attemptMs?: number | null;
  /** Photo processing only: batch wall time outside summed attempts, a lower bound. */
  waitingMs?: number | null;
};

const WORK_LABELS = {
  "photo-context": "Read photos and analysis",
  "photo-analysis": "Read photo analysis",
  "image-description": "Processed image descriptions",
  "image-description-reused": "Reused earlier image descriptions",
  catalog: "Searched existing products",
  records: "Checked Cubby records",
  "photo-groups": "Proposed item groups",
  "product-match": "Proposed product matches",
  "purchase-review": "Prepared orders for review",
  "purchase-import": "Imported approved orders",
  "photo-commit": "Saved reviewed photo groups",
  "photo-review": "Review proposed groups",
} satisfies Record<WorkKind, string>;

function toolWorkKind(name: string): WorkKind | null {
  const leaf = name.split("__").at(-1) ?? name;
  switch (leaf) {
    case "get_photo_run_context":
      return "photo-context";
    case "get_image_processing":
      return "photo-analysis";
    case "resolve_products":
    case "suggest_photo_product_candidates":
      return "catalog";
    case "get_entities":
      return "records";
    case "propose_photo_groups":
      return "photo-groups";
    case "propose_product_match":
      return "product-match";
    case "prepare_purchase_import":
      return "purchase-review";
    case "commit_purchase_import":
      return "purchase-import";
    default:
      return null;
  }
}

export type PlannedPhotoWorkStep = {
  kind: WorkKind;
  label: string;
  status: "upcoming" | "waiting_for_you";
};

/** Milestones the photo workflow always needs, without invented measurements. */
export function plannedPhotoWorkSteps(
  work: readonly AgentWorkItem[],
  runStatus: string,
  proposedGroups: number,
): PlannedPhotoWorkStep[] {
  if (runStatus !== "running") return [];
  const started = new Set(
    work
      .filter((item) => item.completed > 0 || item.running > 0)
      .map((item) => item.kind),
  );
  const reached =
    proposedGroups > 0 || started.has("photo-groups")
      ? 2
      : started.has("catalog")
        ? 1
        : started.has("photo-context") || started.has("records")
          ? 0
          : -1;
  const steps: PlannedPhotoWorkStep[] = [
    {
      kind: "photo-context",
      label: WORK_LABELS["photo-context"],
      status: "upcoming",
    },
    { kind: "catalog", label: "Compare existing products", status: "upcoming" },
    { kind: "photo-groups", label: "Propose item groups", status: "upcoming" },
    {
      kind: "photo-review",
      label: WORK_LABELS["photo-review"],
      status: proposedGroups > 0 ? "waiting_for_you" : "upcoming",
    },
  ];
  return steps.filter((_, index) => index > reached);
}

function operationWorkKind(kind: string): WorkKind | null {
  if (kind === "commit_photo_group") return "photo-commit";
  return null;
}

/** Bounded task-level facts from recorded work. No model-generated recap or inferred timing. */
export function summarizeAgentWork(
  messages: readonly FlueConversationMessage[],
  operations: RunDetail["operations"],
): AgentWorkItem[] {
  const items = new Map<WorkKind, AgentWorkItem>();
  const toolKinds = new Set<WorkKind>();
  const add = (
    kind: WorkKind,
    state: "completed" | "failed" | "running",
    durationMs: number | undefined,
    timing: AgentWorkItem["timing"],
  ) => {
    let item = items.get(kind);
    if (!item) {
      item = {
        kind,
        label: WORK_LABELS[kind],
        completed: 0,
        failed: 0,
        running: 0,
        durationMs: null,
        timing,
      };
      items.set(kind, item);
    }
    item[state] += 1;
    if (durationMs !== undefined && Number.isFinite(durationMs))
      item.durationMs = (item.durationMs ?? 0) + Math.max(0, durationMs);
  };

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      const kind = toolWorkKind(part.toolName);
      if (!kind) continue;
      toolKinds.add(kind);
      add(
        kind,
        part.state === "output-available"
          ? "completed"
          : part.state === "output-error"
            ? "failed"
            : "running",
        part.state === "input-available" ? undefined : part.durationMs,
        "tool",
      );
    }
  }
  for (const operation of operations) {
    const kind = operationWorkKind(operation.kind);
    if (!kind || toolKinds.has(kind)) continue;
    const durationMs = operation.completedAt
      ? new Date(operation.completedAt).getTime() -
        new Date(operation.startedAt).getTime()
      : undefined;
    add(
      kind,
      operation.state === "completed"
        ? "completed"
        : operation.state === "failed"
          ? "failed"
          : "running",
      durationMs,
      "elapsed",
    );
  }
  return [...items.values()];
}

/** Actual dispatch-to-completion wall time for the completed description batch. */
export function summarizePhotoDescriptions(
  images: readonly PhotoRunImage[],
  runStartedAt?: string,
): AgentWorkItem[] {
  const described = images.filter((photo) => photo.describe === "ready");
  if (!described.length) return [];
  const runStartMs = runStartedAt ? Date.parse(runStartedAt) : null;
  const reused = described.filter(
    (photo) =>
      runStartMs !== null &&
      photo.describeStartedAt !== null &&
      photo.describeStartedAt !== undefined &&
      Date.parse(photo.describeStartedAt) < runStartMs,
  );
  const current = described.filter((photo) => !reused.includes(photo));
  const timed = current.flatMap((photo) =>
    photo.describeStartedAt && photo.describeCompletedAt
      ? [
          {
            startedAt: Date.parse(photo.describeStartedAt),
            completedAt: Date.parse(photo.describeCompletedAt),
          },
        ]
      : [],
  );
  const durationMs =
    timed.length === current.length && timed.length > 0
      ? Math.max(
          0,
          Math.max(...timed.map((photo) => photo.completedAt)) -
            Math.min(...timed.map((photo) => photo.startedAt)),
        )
      : null;
  const attemptMs = current.every(
    (photo) =>
      photo.describeAttemptMs !== null && photo.describeAttemptMs !== undefined,
  )
    ? current.reduce((sum, photo) => sum + (photo.describeAttemptMs ?? 0), 0)
    : null;
  const work: AgentWorkItem[] = [];
  if (current.length)
    work.push({
      kind: "image-description",
      label: WORK_LABELS["image-description"],
      completed: current.length,
      failed: 0,
      running: 0,
      durationMs,
      timing: "elapsed",
      attemptMs,
      waitingMs:
        durationMs !== null && attemptMs !== null
          ? Math.max(0, durationMs - attemptMs)
          : null,
    });
  if (reused.length)
    work.push({
      kind: "image-description-reused",
      label: WORK_LABELS["image-description-reused"],
      completed: reused.length,
      failed: 0,
      running: 0,
      durationMs: null,
      timing: "elapsed",
    });
  return work;
}
