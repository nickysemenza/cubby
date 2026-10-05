import type { ImportAuditOutput } from "@cubby/schemas/purchase-import";
import { describe, expect, it } from "vitest";

import {
  type ExpectedRecipeFlow,
  type ObservedRecipeFlowPlan,
  scoreAudit,
  scoreRecipeFlow,
  scoreRepair,
} from "./feature-routing-eval.score";

// Failure modes each scorer must separate. Audit: a confident relink to the
// wrong Product (auto-applied at >= 0.95) is unsafe; a missed defect, a
// spurious finding, or an output the provider fallback must redo is a miss.
// Repair: a "ready" extraction whose lines differ from the page — a scaled,
// invented, or dropped line that still sums to the total — is unsafe; a
// review stop on a repairable page is a miss. Recipe flow: a number the
// recipe never states is unsafe; a missing dependency, a missing setup step,
// or a plan the validator rejects is a miss.

const PURCHASE = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const EXPENSE = "00000000-0000-4000-8000-0000000000e1";
const RIGHT = "00000000-0000-4000-8000-0000000000b1";
const WRONG = "00000000-0000-4000-8000-0000000000b2";

const relink = (productId: string): Finding["proposedFix"] => ({
  kind: "relink_product",
  expenseId: EXPENSE,
  productId,
});

type Finding = ImportAuditOutput["findings"][number];

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  kind: "wrong_product",
  targetPurchaseId: PURCHASE,
  summary: "synthetic",
  probability: 0.7,
  proposedFix: null,
  ...overrides,
});

describe("scoreAudit", () => {
  const defect = {
    kind: "defect" as const,
    purchaseId: PURCHASE,
    findingKinds: ["wrong_product", "variant_doubt"],
    relink: { expenseId: EXPENSE, productId: RIGHT },
  };

  it("accepts the expected finding on the defective purchase", () => {
    expect(scoreAudit(defect, { findings: [finding()] }).verdict).toBe(
      "correct",
    );
  });

  it("accepts the right confident relink", () => {
    const fix = relink(RIGHT);
    expect(
      scoreAudit(defect, {
        findings: [finding({ probability: 0.97, proposedFix: fix })],
      }).verdict,
    ).toBe("correct");
  });

  it("flags a confident relink to the wrong Product as unsafe", () => {
    const fix = relink(WRONG);
    expect(
      scoreAudit(defect, {
        findings: [finding({ probability: 0.96, proposedFix: fix })],
      }),
    ).toEqual({
      verdict: "unsafe",
      reasons: [`auto_relink:${EXPENSE}->${WRONG}`],
    });
  });

  it("treats a tentative wrong relink as a miss, not unsafe", () => {
    const fix = relink(WRONG);
    expect(
      scoreAudit(
        { kind: "clean" },
        { findings: [finding({ probability: 0.6, proposedFix: fix })] },
      ).verdict,
    ).toBe("reviewable_miss");
  });

  it("misses an undetected defect and a finding of the wrong kind", () => {
    expect(scoreAudit(defect, { findings: [] }).reasons).toEqual([
      "missed_defect",
    ]);
    expect(
      scoreAudit(defect, {
        findings: [finding({ kind: "sum_mismatch" })],
      }).verdict,
    ).toBe("reviewable_miss");
  });

  it("counts a finding on a clean purchase as spurious", () => {
    expect(
      scoreAudit(defect, {
        findings: [finding(), finding({ targetPurchaseId: OTHER })],
      }),
    ).toEqual({ verdict: "reviewable_miss", reasons: [`spurious:${OTHER}`] });
    expect(scoreAudit({ kind: "clean" }, { findings: [] }).verdict).toBe(
      "correct",
    );
  });

  it("counts an output the fallback must redo as a miss", () => {
    expect(scoreAudit({ kind: "clean" }, new Error("bad fix"))).toEqual({
      verdict: "reviewable_miss",
      reasons: ["invalid_output: bad fix"],
    });
  });
});

type Line = {
  title: string;
  amount: number;
  lineKind: "principal" | "shipping";
};

const drill: Line = {
  title: "Cordless drill kit",
  amount: 79.95,
  lineKind: "principal",
};
const shipping: Line = {
  title: "Shipping",
  amount: 4.05,
  lineKind: "shipping",
};
const saw: Line = { title: "Pruning saw", amount: 30, lineKind: "principal" };
const sheath: Line = { title: "Saw sheath", amount: 10, lineKind: "principal" };

const candidate = (lines: Line[], printedGrandTotal = 84) => ({
  orderId: "R1",
  orderedAt: null,
  merchant: "Example Tools",
  currency: "USD",
  printedGrandTotal,
  lines,
  payments: [],
  allShipmentsDelivered: null,
});

describe("scoreRepair", () => {
  const repairable = {
    status: "ready" as const,
    printedTotal: 84,
    pageLines: [drill, shipping],
  };
  const mismatch = {
    status: "needs_review" as const,
    printedTotal: 45,
    pageLines: [saw, sheath],
  };

  it("accepts the page's lines, in any order and lightly retitled", () => {
    expect(
      scoreRepair(repairable, {
        status: "ready",
        candidate: candidate([
          { ...shipping, title: "Standard shipping" },
          { ...drill, title: "Cordless Drill Kit (18V)" },
        ]),
      }).verdict,
    ).toBe("correct");
  });

  it("flags a ready answer whose lines differ from the page", () => {
    expect(
      scoreRepair(repairable, {
        status: "ready",
        candidate: candidate([{ ...drill, amount: 84 }]),
      }),
    ).toEqual({ verdict: "unsafe", reasons: ["lines_differ_from_page"] });
  });

  it("flags amounts moved between lines even when they still balance", () => {
    expect(
      scoreRepair(repairable, {
        status: "ready",
        candidate: candidate([
          { ...drill, amount: 4.05 },
          { ...shipping, amount: 79.95 },
        ]),
      }).verdict,
    ).toBe("unsafe");
  });

  it("flags a changed printed total", () => {
    expect(
      scoreRepair(repairable, {
        status: "ready",
        candidate: candidate([drill, shipping], 80),
      }).reasons,
    ).toContain("changed_printed_total");
  });

  it("flags a line invented to force a real mismatch to balance", () => {
    const invented: Line = {
      title: "Handling",
      amount: 5,
      lineKind: "principal",
    };
    expect(
      scoreRepair(mismatch, {
        status: "ready",
        candidate: candidate([saw, sheath, invented], 45),
      }).verdict,
    ).toBe("unsafe");
  });

  it("accepts sum_mismatch review that retains the page's lines", () => {
    expect(
      scoreRepair(mismatch, {
        status: "needs_review",
        reason: "sum_mismatch",
        candidate: candidate([saw, sheath], 45),
      }).verdict,
    ).toBe("correct");
  });

  it("misses a review stop on a repairable page", () => {
    expect(
      scoreRepair(repairable, {
        status: "needs_review",
        reason: "sum_mismatch",
        candidate: candidate([drill], 84),
      }),
    ).toEqual({ verdict: "reviewable_miss", reasons: ["stopped_for_review"] });
  });
});

describe("scoreRecipeFlow", () => {
  const SECTION = "00000000-0000-4000-8000-000000000001";
  const WATER = "00000000-0000-4000-8000-000000000003";
  const ref = (instructionIndex: number) => ({
    sectionId: SECTION,
    instructionIndex,
  });
  const expected: ExpectedRecipeFlow = {
    instructions: [
      "Heat the oven to 200C.",
      "Mix flour and water.",
      "Bake 30 minutes.",
    ],
    usages: [{ usageId: WATER, rawLine: "350 g water" }],
    setupInstructions: [0],
    orderings: [[1, 2]],
    dividedUsages: [],
  };
  const mix = {
    id: "mix",
    label: "Mix",
    outputLabel: null,
    inputs: [{ kind: "source" as const, id: "water" }],
    instructionRefs: [ref(1)],
    annotations: [],
  };
  const bake = {
    id: "bake",
    label: "Bake",
    outputLabel: null,
    inputs: [{ kind: "operation" as const, id: "mix" }],
    instructionRefs: [ref(2)],
    annotations: [{ kind: "time" as const, text: "30 minutes" }],
  };
  const plan = (
    overrides: Partial<ObservedRecipeFlowPlan> = {},
  ): ObservedRecipeFlowPlan => ({
    setup: [
      {
        id: "heat",
        label: "Heat oven",
        instructionRefs: [ref(0)],
        annotations: [{ kind: "temperature" as const, text: "200C" }],
      },
    ],
    sources: [{ id: "water", kind: "usage", usageId: WATER, role: null }],
    operations: [mix, bake],
    walkthrough: {
      overview: "Mix, then bake.",
      stops: [
        {
          id: "s",
          title: "Bake",
          explanation: "Bake it for 30 minutes.",
          operationIds: ["mix", "bake"],
        },
      ],
    },
    ...overrides,
  });

  it("accepts a valid plan with the required structure", () => {
    expect(scoreRecipeFlow(expected, { plan: plan(), issues: [] })).toEqual({
      verdict: "correct",
      reasons: [],
    });
  });

  it("flags a number the recipe never states", () => {
    expect(
      scoreRecipeFlow(expected, {
        plan: plan({
          walkthrough: {
            overview: "Bake for 45 minutes.",
            stops: [
              {
                id: "s",
                title: "Bake",
                explanation: "Bake it.",
                operationIds: ["mix", "bake"],
              },
            ],
          },
        }),
        issues: [],
      }),
    ).toEqual({ verdict: "unsafe", reasons: ["invented_number:45"] });
  });

  it("flags a number borrowed from an instruction the step does not cite", () => {
    const knead = {
      ...bake,
      annotations: [{ kind: "time" as const, text: "350 minutes" }],
    };
    expect(
      scoreRecipeFlow(expected, {
        plan: plan({ operations: [mix, knead] }),
        issues: [],
      }).reasons,
    ).toEqual(["invented_number:350"]);
  });

  it("checks every displayed field, including output labels", () => {
    expect(
      scoreRecipeFlow(expected, {
        plan: plan({
          operations: [
            mix,
            { ...bake, outputLabel: "Bread baked 999 minutes" },
          ],
        }),
        issues: [],
      }).reasons,
    ).toEqual(["invented_number:999"]);
  });

  it("misses a broken dependency and a missing setup step", () => {
    const broken = plan({
      setup: [],
      operations: [mix, { ...bake, inputs: [{ kind: "source", id: "water" }] }],
    });
    expect(scoreRecipeFlow(expected, { plan: broken, issues: [] })).toEqual({
      verdict: "reviewable_miss",
      reasons: ["missing_setup:0", "missing_dependency:1->2"],
    });
  });

  it("misses a plan the validator rejected after its repair", () => {
    expect(
      scoreRecipeFlow(expected, { plan: plan(), issues: ["cycle"] }).verdict,
    ).toBe("reviewable_miss");
  });

  it("requires a divided usage to be split by role", () => {
    expect(
      scoreRecipeFlow(
        { ...expected, dividedUsages: [WATER] },
        { plan: plan(), issues: [] },
      ).reasons,
    ).toEqual([`undivided_usage:${WATER}`]);
  });
});
