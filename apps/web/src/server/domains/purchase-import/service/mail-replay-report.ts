import type { mailImportOutcome } from "@cubby/schemas/assessment";
import { isEqual } from "es-toolkit";
import type { z } from "zod";

type Outcome = z.infer<typeof mailImportOutcome>;

/** Mechanical parity is evidence for blind review, never a quality grade. */
export function mailReplayDisagreement(
  baseline: Outcome,
  replay: Outcome | null,
): string[] {
  if (!replay) return ["unavailable"];
  if (baseline.kind !== replay.kind) return ["kind"];
  if (baseline.kind === "imported" && replay.kind === "imported") {
    const lines = (outcome: typeof baseline) =>
      outcome.lines
        .map((line) =>
          JSON.stringify({
            name: line.name,
            cost: line.cost === null ? null : Math.round(line.cost * 100),
          }),
        )
        .sort();
    const total = (outcome: typeof baseline) =>
      outcome.total === null ? null : Math.round(outcome.total * 100);
    return [
      ...(total(baseline) === total(replay) ? [] : ["total"]),
      ...(isEqual(lines(baseline), lines(replay)) ? [] : ["lines"]),
    ];
  }
  if (baseline.kind === "linked" && replay.kind === "linked") {
    const fields = baseline.event === replay.event ? [] : ["event"];
    const hasIdentity = (outcome: typeof baseline) =>
      outcome.purchases.length > 0 &&
      outcome.purchases.every((target) => target.orderId && target.vendor);
    if (!hasIdentity(baseline) || !hasIdentity(replay))
      return [...fields, "target_identity_unavailable"];
    const targets = (outcome: typeof baseline) =>
      outcome.purchases.map((target) => JSON.stringify(target)).sort();
    return isEqual(targets(baseline), targets(replay))
      ? fields
      : [...fields, "purchases"];
  }
  if ("reason" in baseline && "reason" in replay)
    return baseline.reason === replay.reason ? [] : ["reason"];
  return [];
}
