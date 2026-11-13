import type { KernelStage } from "@cubby/schemas/kernel/stage";
import { selectControlOptions } from "@cubby/schemas/select-control-options";

import type { BadgeVariant } from "~/ui/reui/badge";

const STAGE_TONE = {
  ended: "secondary",
  stuck: "destructive",
  working: "secondary",
  needs_you: "warning",
  waiting: "secondary",
  done: "secondary",
} satisfies Record<KernelStage, BadgeVariant>;

/** Routine states stay quiet; only a member gap or a failure calls for attention. */
export function statusTone(
  domain: "task" | "project" | "audit" | "confidence",
  value: string | null | undefined,
): BadgeVariant {
  if (domain === "audit" || domain === "confidence") return "secondary";
  const options =
    domain === "task"
      ? selectControlOptions.taskStatus
      : selectControlOptions.projectStatus;
  const option = options.find((option) => option.value === value);
  return option?.stage ? STAGE_TONE[option.stage] : "slate";
}

/** Text-colour class for a tone, for status shown as plain text rather than a chip. */
export const badgeToneTextClass = {
  default: "text-primary",
  secondary: "text-muted-foreground",
  destructive: "text-destructive",
  positive: "text-positive",
  warning: "text-warning-ink",
  plum: "text-plum",
  slate: "text-slate",
  outline: "text-muted-foreground",
} satisfies Record<BadgeVariant, string>;
