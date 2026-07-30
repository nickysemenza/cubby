import { Row, Stack } from "~/components/layout";
import { cn, formatCurrency } from "~/lib/utils";
import { budgetRemaining, type SpendSplit } from "./spend";

/**
 * Reconciles the four money quantities a single "Spent" figure hides — estimate,
 * actual, committed (future), and contributions (negative expenses) — over a
 * burn bar. Actual + committed stack against the estimate envelope; a marker sits
 * at 100% of estimate; the Remaining figure nets out contributions and turns
 * `destructive` when net spend exceeds the estimate.
 *
 * Zero-value figures are omitted, so a plain project (no future, no
 * contributions) collapses to Estimate · Actual · Remaining with a clean bar.
 */
export function BudgetStrip({
  estimate,
  split,
}: {
  estimate: number | null;
  split: SpendSplit;
}) {
  const { actual, committed, contributions } = split;
  const remaining = budgetRemaining(estimate, split);
  const gross = actual + committed;

  // Scale to whichever is larger so the estimate marker stays on-bar even when
  // gross spend overruns it (same trick as BudgetHealth).
  const scaleMax = Math.max(estimate ?? 0, gross) || 1;
  const actualPct = (actual / scaleMax) * 100;
  const committedPct = (committed / scaleMax) * 100;
  const estimateMarkerPct =
    estimate != null && estimate > 0 ? (estimate / scaleMax) * 100 : null;

  const overBudget = remaining != null && remaining < 0;

  return (
    <Stack gap="sm">
      <Row wrap gap="md" className="justify-between">
        <Figure label="Estimate" value={estimate} />
        <Figure label="Actual" value={actual} tone="positive" />
        {committed > 0 && (
          <Figure label="Committed" value={committed} tone="warning" />
        )}
        {contributions > 0 && (
          <Figure label="Contributions" value={-contributions} tone="muted" />
        )}
        <Figure
          label="Remaining"
          value={remaining}
          tone={overBudget ? "destructive" : undefined}
        />
      </Row>

      <div
        className="relative h-3 w-full overflow-hidden bg-muted"
        role="img"
        aria-label={`Spent ${formatCurrency(actual, 0)} of estimate ${estimate != null ? formatCurrency(estimate, 0) : "unset"}${committed > 0 ? `, ${formatCurrency(committed, 0)} committed` : ""}`}
      >
        <div className="flex h-full w-full">
          <div
            className="h-full bg-positive transition-all"
            style={{ width: `${Math.min(actualPct, 100)}%` }}
          />
          <div
            className="h-full bg-warning transition-all"
            style={{
              width: `${Math.min(committedPct, 100 - Math.min(actualPct, 100))}%`,
            }}
          />
        </div>
        {estimateMarkerPct != null && estimateMarkerPct < 100 && (
          <div
            className="absolute top-0 h-full w-px bg-foreground/40"
            style={{ left: `${estimateMarkerPct}%` }}
          />
        )}
      </div>
    </Stack>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: "positive" | "warning" | "destructive" | "muted";
}) {
  return (
    <Stack gap="tight">
      <span className="eyebrow my-0">{label}</span>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "positive" && "text-positive",
          tone === "warning" && "text-warning",
          tone === "destructive" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value != null ? formatCurrency(value, 0) : "—"}
      </span>
    </Stack>
  );
}
