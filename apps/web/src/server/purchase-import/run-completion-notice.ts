import type { BrowserBridgeRunCompletion } from "@cubby/schemas/purchase-import";
import {
  countRunTargets,
  type RunTargetState,
} from "@cubby/schemas/purchase-import";
import { runWorkLabel } from "@cubby/schemas/run-fields";

const ENDING = {
  completed: "complete",
  needs_review: "needs review",
  failed: "stopped",
  dispatch_failed: "could not start",
} as const satisfies Record<
  BrowserBridgeRunCompletion["terminalStatus"],
  string
>;

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The Mac's completion notification, written once by the server in the unit
 * the run worked in, so a new kind of run needs no Mac release.
 */
export function runCompletionNotice(run: {
  purpose: string;
  input: unknown;
  vendorId: string | null;
  vendorName: string | null;
  terminalStatus: BrowserBridgeRunCompletion["terminalStatus"];
  imported: number;
  updated: number;
  skipped: number;
  findingCount: number;
  targetStates: readonly RunTargetState[];
}): NonNullable<BrowserBridgeRunCompletion["notice"]> {
  const work = runWorkLabel(run);
  const title = `${run.vendorName ? `${run.vendorName}: ` : ""}${work} ${ENDING[run.terminalStatus]}`;
  const findings = run.findingCount
    ? ` ${plural(run.findingCount, "item needs", "items need")} review.`
    : "";
  if (run.purpose === "product_enrichment") {
    const counts = countRunTargets(run.targetStates);
    const parts = [
      `${counts.completed} of ${plural(counts.total, "product", "products")} enriched`,
      counts.skipped ? `${counts.skipped} skipped` : null,
      counts.blocked ? `${counts.blocked} waiting on you` : null,
    ].filter(Boolean);
    return { title, body: `${parts.join("; ")}.${findings}` };
  }
  const changed = run.imported + run.updated;
  return {
    title,
    body: `${plural(changed, "order", "orders")} changed; ${run.skipped} skipped.${findings}`,
  };
}
