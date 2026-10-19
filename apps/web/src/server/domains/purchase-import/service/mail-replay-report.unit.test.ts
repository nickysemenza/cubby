import { describe, expect, it } from "vitest";

import {
  mailReplayDisagreement,
  observeMailReplayAttempt,
} from "./mail-replay-report";

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
  it("compares linked order/vendor identity and never calls missing identity parity", () => {
    const baseline = {
      kind: "linked" as const,
      event: "shipped",
      purchases: [
        { orderId: "SYNTHETIC-ORDER-A", vendor: "Synthetic merchant" },
      ],
    };
    expect(
      mailReplayDisagreement(baseline, {
        ...baseline,
        purchases: [
          { orderId: "SYNTHETIC-ORDER-B", vendor: "Synthetic merchant" },
        ],
      }),
    ).toEqual(["purchases"]);
    expect(
      mailReplayDisagreement(baseline, {
        ...baseline,
        purchases: [
          {
            orderId: "SYNTHETIC-ORDER-A",
            vendor: "Another synthetic merchant",
          },
        ],
      }),
    ).toEqual(["purchases"]);
    expect(
      mailReplayDisagreement(baseline, {
        ...baseline,
        purchases: [{ orderId: null, vendor: "Synthetic merchant" }],
      }),
    ).toEqual(["target_identity_unavailable"]);
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

// Teardown must follow observation even when the coordinator times out, and
// unavailable outcomes must retain every successful model call and every
// refused attempt's raw error already seen.
it("retains model usage and attempt errors before failed replay teardown", async () => {
  const reports: { actualModels: string[]; fields: string[] }[] = [];
  const order: string[] = [];
  try {
    await expect(
      observeMailReplayAttempt({
        caseIndex: 1,
        baseline: { kind: "unresolved", reason: "Synthetic missing total" },
        run: async () => {
          order.push("run");
          throw new Error("Synthetic coordinator timeout");
        },
        read: async () => {
          order.push("read");
          return {
            status: "running",
            outcome: { kind: "unresolved", reason: "Synthetic missing total" },
            actualModels: ["claude-haiku-5-5", "claude-opus-5-5"],
            failure: "agent_failed: Coordinator unanswered: error",
            failedAttempts: [
              "claude-opus-5-5 (gateway): Synthetic usage limit refusal",
            ],
            diagnostics: ["[purchase-agent] Synthetic operation failure"],
          };
        },
        record: (report) => {
          reports.push(report);
        },
      }),
    ).rejects.toThrow("Synthetic coordinator timeout");
  } finally {
    order.push("teardown");
  }
  expect(order).toEqual(["run", "read", "teardown"]);
  expect(reports).toMatchObject([
    {
      actualModels: ["claude-haiku-5-5", "claude-opus-5-5"],
      fields: ["unavailable"],
      failure:
        "agent_failed: Coordinator unanswered: error; Error: Synthetic coordinator timeout",
      failedAttempts: [
        "claude-opus-5-5 (gateway): Synthetic usage limit refusal",
      ],
      diagnostics: ["[purchase-agent] Synthetic operation failure"],
    },
  ]);
});
