import type { PhotoRunImage } from "@cubby/schemas/photo-import-run";
import type { FlueConversationMessage } from "@flue/sdk";

import type { ImportRunDetail } from "~/lib/purchase-import-run-detail";

type WorkKind =
  | "photo-analysis"
  | "image-description"
  | "catalog"
  | "records"
  | "photo-groups"
  | "product-match"
  | "purchase-review"
  | "purchase-import"
  | "photo-commit";

export type AgentWorkItem = {
  kind: WorkKind;
  label: string;
  completed: number;
  failed: number;
  running: number;
  durationMs: number | null;
  timing: "tool" | "elapsed";
};

const WORK_LABELS = {
  "photo-analysis": "Read photo analysis",
  "image-description": "Processed image descriptions",
  catalog: "Searched existing products",
  records: "Checked Cubby records",
  "photo-groups": "Proposed item groups",
  "product-match": "Proposed product matches",
  "purchase-review": "Prepared orders for review",
  "purchase-import": "Imported approved orders",
  "photo-commit": "Saved reviewed photo groups",
} satisfies Record<WorkKind, string>;

function toolWorkKind(name: string): WorkKind | null {
  const leaf = name.split("__").at(-1) ?? name;
  switch (leaf) {
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

function operationWorkKind(kind: string): WorkKind | null {
  if (kind === "commit_photo_group") return "photo-commit";
  return null;
}

/** Bounded task-level facts from recorded work. No model-generated recap or inferred timing. */
export function summarizeAgentWork(
  messages: readonly FlueConversationMessage[],
  operations: ImportRunDetail["operations"],
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

export function formatWorkDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

/** Actual dispatch-to-completion wall time for the completed description batch. */
export function summarizePhotoDescriptions(
  images: readonly PhotoRunImage[],
): AgentWorkItem[] {
  const described = images.filter((photo) => photo.describe === "ready");
  if (!described.length) return [];
  const timed = described.flatMap((photo) =>
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
    timed.length === described.length
      ? Math.max(
          0,
          Math.max(...timed.map((photo) => photo.completedAt)) -
            Math.min(...timed.map((photo) => photo.startedAt)),
        )
      : null;
  return [
    {
      kind: "image-description",
      label: WORK_LABELS["image-description"],
      completed: described.length,
      failed: 0,
      running: 0,
      durationMs,
      timing: "elapsed",
    },
  ];
}
