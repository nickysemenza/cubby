import type { Confidence } from "@cubby/schemas/ai";
import type { FinancialStatementImportPreviewOut } from "@cubby/schemas/financial-transaction";
import type { ProjectStatus } from "@cubby/schemas/project-fields";
import type {
  StatementRowDisposition,
  StatementRowMatchState,
} from "@cubby/schemas/statement-row";
import type { TaskStatus } from "@cubby/schemas/task-fields";
import type { McpToolUsageStatus } from "@cubby/schemas/telemetry";

import type { BadgeVariant } from "~/components/ui/badge";

type StatementImportStatus =
  FinancialStatementImportPreviewOut["rows"][number]["status"];

/**
 * One tone per enum value. A status is condition, so it lands on
 * positive/warning/destructive; values with no condition of their own use the
 * untoned variants and their text label carries the meaning. Add a domain here
 * rather than a local value → variant map next to a component.
 */
const STATUS_TONES = {
  task: {
    not_started: "secondary",
    later: "outline",
    in_progress: "warning",
    blocked: "destructive",
    done: "positive",
  } satisfies Record<TaskStatus, BadgeVariant>,
  project: {
    planning: "plum",
    not_started: "secondary",
    in_progress: "warning",
    done: "positive",
  } satisfies Record<ProjectStatus, BadgeVariant>,
  audit: {
    create: "secondary",
    update: "slate",
    delete: "destructive",
  },
  statementMatch: {
    matched: "positive",
    unmatched: "warning",
    superseded: "slate",
    ignored: "secondary",
  } satisfies Record<StatementRowMatchState, BadgeVariant>,
  statementDisposition: {
    open: "outline",
    ignored: "secondary",
  } satisfies Record<StatementRowDisposition, BadgeVariant>,
  statementImport: {
    ready_to_create: "default",
    already_recorded: "secondary",
    possible_existing: "warning",
    unresolved_account: "warning",
    indistinguishable_duplicate: "warning",
  } satisfies Record<StatementImportStatus, BadgeVariant>,
  mcpUsage: {
    active: "default",
    inactive: "secondary",
    never: "outline",
    retired: "outline",
  } satisfies Record<McpToolUsageStatus, BadgeVariant>,
  confidence: {
    high: "positive",
    medium: "warning",
    low: "destructive",
  } satisfies Record<Confidence, BadgeVariant>,
} as const;

export type StatusDomain = keyof typeof STATUS_TONES;

/** The `<Badge variant>` for a status value; an unknown value reads as a neutral chip. */
export function statusTone(
  domain: StatusDomain,
  value: string | null | undefined,
): BadgeVariant {
  if (value == null) return "slate";
  const tones: Readonly<Record<string, BadgeVariant>> = STATUS_TONES[domain];
  return tones[value] ?? "slate";
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
