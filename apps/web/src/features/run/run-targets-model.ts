import type { RunDetail } from "~/contracts/run.contract";

export type RunTarget = RunDetail["targets"][number];

export const targetName = (target: RunTarget) =>
  target.targetName ?? target.targetShortcode ?? target.targetType;

/** Attention offers a record to inspect; unlinked failures remain visible in Results. */
export const targetNeedsAttention = (target: RunTarget) =>
  Boolean(target.targetShortcode) &&
  ["unresolved", "needs_evidence", "unavailable"].includes(target.state);

/** Keep existing positions while accepting refreshed values; arrivals wait for acknowledgement. */
export function stableTargetRows(
  rows: readonly RunTarget[],
  admittedIds: readonly string[],
): RunTarget[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return admittedIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}
