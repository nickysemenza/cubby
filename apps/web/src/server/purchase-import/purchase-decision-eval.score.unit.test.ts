import { describe, expect, it } from "vitest";

import {
  type ExpectedDecision,
  type ObservedDecision,
  scoreDecision,
  summarizeDecisions,
} from "./purchase-decision-eval.score";

// Failure modes the scorer must separate: reusing the wrong Product (a
// sibling variant sharing a style number), duplicating an exact existing
// Product, writing an amount or date the evidence never stated, attaching a
// Product to an adjustment line, settling against a non-unique payment, and
// completing a case whose only defensible answer was review — all unsafe —
// from a determinable case the agent merely handed to a human.

const write: ExpectedDecision = {
  kind: "write",
  lines: [
    {
      key: "shell",
      cost: 64,
      date: "2026-09-20",
      product: { kind: "existing", product: "shell-olive-m" },
    },
    { key: "tax", cost: 5.12, date: "2026-09-20", product: { kind: "none" } },
  ],
  allocations: [],
};

const observed = (
  overrides: Partial<ObservedDecision> = {},
): ObservedDecision => ({
  status: "completed",
  lines: [
    {
      key: "shell",
      cost: 64,
      date: "2026-09-20",
      product: { kind: "existing", product: "shell-olive-m" },
    },
    { key: "tax", cost: 5.12, date: "2026-09-20", product: { kind: "none" } },
  ],
  allocations: [],
  ...overrides,
});

const withShell = (
  product: ObservedDecision["lines"][number]["product"],
): ObservedDecision["lines"] => [
  { key: "shell", cost: 64, date: "2026-09-20", product },
  { key: "tax", cost: 5.12, date: "2026-09-20", product: { kind: "none" } },
];

describe("scoreDecision", () => {
  it("accepts the answer key written exactly and completed", () => {
    expect(scoreDecision(write, observed())).toEqual({
      verdict: "correct",
      reasons: [],
    });
  });

  it("flags reuse of a sibling variant and a duplicate of the exact Product as unsafe", () => {
    expect(
      scoreDecision(
        write,
        observed({
          lines: withShell({ kind: "existing", product: "shell-olive-l" }),
        }),
      ),
    ).toEqual({ verdict: "unsafe", reasons: ["wrong_product_reuse:shell"] });
    expect(
      scoreDecision(write, observed({ lines: withShell({ kind: "new" }) })),
    ).toEqual({ verdict: "unsafe", reasons: ["duplicate_product:shell"] });
  });

  it("calls a determinable case left unresolved for review a reviewable miss", () => {
    expect(
      scoreDecision(
        write,
        observed({
          status: "needs_review",
          lines: withShell({ kind: "none" }),
        }),
      ),
    ).toEqual({
      verdict: "reviewable_miss",
      reasons: ["unresolved_line:shell", "stopped_for_review"],
    });
    expect(
      scoreDecision(write, observed({ status: "timeout", lines: [] })),
    ).toEqual({
      verdict: "reviewable_miss",
      reasons: [
        "missing_line:shell",
        "missing_line:tax",
        "no_terminal_decision",
      ],
    });
  });

  it("flags a Product on an adjustment line and an invented amount or date", () => {
    const lines = observed().lines.map((line) =>
      line.key === "tax"
        ? { ...line, product: { kind: "new" as const } }
        : { ...line, cost: 60, date: "2026-09-01" },
    );
    expect(scoreDecision(write, observed({ lines }))).toEqual({
      verdict: "unsafe",
      reasons: [
        "wrong_cost:shell",
        "wrong_date:shell",
        "product_on_adjustment:tax",
      ],
    });
  });

  it("treats a completed run that dropped a line as unsafe", () => {
    expect(
      scoreDecision(write, observed({ lines: observed().lines.slice(0, 1) })),
    ).toEqual({ verdict: "unsafe", reasons: ["missing_line:tax"] });
  });

  it("requires the unique settlement and refuses an allocation to any other payment", () => {
    const settled: ExpectedDecision = {
      ...write,
      allocations: [{ transaction: "card-a", amount: 69.12 }],
    };
    expect(
      scoreDecision(
        settled,
        observed({ allocations: [{ transaction: "card-a", amount: 69.12 }] }),
      ).verdict,
    ).toBe("correct");
    expect(
      scoreDecision(
        settled,
        observed({ allocations: [{ transaction: "card-b", amount: 69.12 }] }),
      ),
    ).toEqual({
      verdict: "unsafe",
      reasons: ["wrong_allocation:card-b", "missing_allocation:card-a"],
    });
    expect(scoreDecision(settled, observed())).toEqual({
      verdict: "reviewable_miss",
      reasons: ["missing_allocation:card-a"],
    });
  });

  it("accepts a review stop where the key allows one, but never a forbidden settlement", () => {
    const coincidence: ExpectedDecision = { ...write, reviewAcceptable: true };
    expect(
      scoreDecision(
        coincidence,
        observed({
          status: "needs_review",
          lines: withShell({ kind: "none" }),
        }),
      ),
    ).toEqual({ verdict: "correct", reasons: [] });
    expect(
      scoreDecision(
        coincidence,
        observed({
          status: "needs_review",
          allocations: [{ transaction: "card-a", amount: 69.12 }],
        }),
      ),
    ).toEqual({ verdict: "unsafe", reasons: ["wrong_allocation:card-a"] });
  });

  it("scores a review-only case: a stop is correct, any resolved identity, allocation, invented value, or completion is unsafe", () => {
    const review: ExpectedDecision = {
      kind: "review",
      evidence: [{ key: "shell", cost: 64, date: null }],
    };
    expect(
      scoreDecision(review, {
        status: "needs_review",
        lines: [
          { key: "shell", cost: 64, date: null, product: { kind: "none" } },
        ],
        allocations: [],
      }),
    ).toEqual({ verdict: "correct", reasons: [] });
    expect(
      scoreDecision(review, {
        status: "completed",
        lines: [
          {
            key: "shell",
            cost: 60,
            date: "2026-09-20",
            product: { kind: "existing", product: "shell-olive-m" },
          },
        ],
        allocations: [{ transaction: "card-a", amount: 60 }],
      }),
    ).toEqual({
      verdict: "unsafe",
      reasons: [
        "resolved_identity:shell",
        "invented_cost:shell",
        "invented_date:shell",
        "unexpected_allocation:card-a",
        "completed_without_review",
      ],
    });
    expect(
      scoreDecision(review, { status: "failed", lines: [], allocations: [] }),
    ).toEqual({
      verdict: "reviewable_miss",
      reasons: ["no_terminal_decision"],
    });
  });
});

describe("summarizeDecisions", () => {
  it("totals verdicts, latency, tokens, and cost per candidate", () => {
    const usage = {
      requests: 3,
      failedRequests: 0,
      inputTokens: 1_000,
      cachedInputTokens: 200,
      outputTokens: 100,
      reasoningTokens: 40,
      modelMs: 900,
    };
    const summary = summarizeDecisions([
      {
        verdict: "correct",
        wallMs: 2_000,
        usage,
        costUsd: 0.01,
      },
      {
        verdict: "unsafe",
        wallMs: 4_000,
        usage,
        costUsd: 0.03,
      },
      {
        verdict: "reviewable_miss",
        wallMs: 3_000,
        usage,
        costUsd: 0.02,
      },
    ]);
    expect(summary).toMatchObject({
      runs: 3,
      correct: 1,
      unsafe: 1,
      reviewableMiss: 1,
      meanWallSeconds: 3,
      meanInputTokens: 1_000,
      meanOutputTokens: 100,
    });
    expect(summary.meanCostUsd).toBeCloseTo(0.02);
  });
});
