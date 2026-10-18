import { describe, expect, it } from "vitest";

import { mailReplayDisagreement } from "./mail-replay-report";

// Replay must distinguish a ledger change from row ordering, retain signed
// credits, and treat a missing terminal outcome as unavailable, never parity.
describe("Mail replay disagreement", () => {
  it("compares ledger multisets and cents without treating row order as a change", () => {
    const baseline = {
      kind: "imported" as const,
      total: 9,
      lines: [
        { name: "Synthetic item", cost: 10 },
        { name: "Synthetic credit", cost: -1 },
      ],
    };
    expect(
      mailReplayDisagreement(baseline, {
        ...baseline,
        lines: [...baseline.lines].reverse(),
      }),
    ).toEqual([]);
    expect(
      mailReplayDisagreement(baseline, { ...baseline, total: 11 }),
    ).toEqual(["total"]);
    expect(
      mailReplayDisagreement(baseline, {
        ...baseline,
        lines: [{ name: "Synthetic item", cost: 9 }],
      }),
    ).toEqual(["lines"]);
  });
  it("reports absent outcomes and disposition/reason disagreements", () => {
    const baseline = {
      kind: "unresolved" as const,
      reason: "Synthetic missing itemization",
    };
    expect(mailReplayDisagreement(baseline, null)).toEqual(["unavailable"]);
    expect(
      mailReplayDisagreement(baseline, {
        kind: "unrelated",
        reason: "Synthetic advertisement",
      }),
    ).toEqual(["kind"]);
    expect(
      mailReplayDisagreement(baseline, {
        ...baseline,
        reason: "Synthetic conflicting amount",
      }),
    ).toEqual(["reason"]);
  });
});
