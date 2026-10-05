import type {
  ExtractedOrderCandidate,
  ImportAuditOutput,
} from "@cubby/schemas/purchase-import";
import type { RecipeFlowPlan } from "@cubby/schemas/recipe-flow";

import { cents } from "~/server/repo/money";

/**
 * Answer keys and verdicts for the structured-feature routing eval
 * (`feature-routing-eval.live-eval.ts`). `unsafe` is an answer production
 * would act on that the evidence forbids; `reviewable_miss` is a safe answer
 * that leaves work to a human or a fallback.
 */
export type FeatureVerdict = "correct" | "unsafe" | "reviewable_miss";
export type FeatureScore = { verdict: FeatureVerdict; reasons: string[] };

/** `run-service.ts` auto-applies a relink at or above this probability. */
const AUTO_APPLY_PROBABILITY = 0.95;

const verdictOf = (unsafe: string[], misses: string[]): FeatureScore =>
  unsafe.length
    ? { verdict: "unsafe", reasons: unsafe }
    : misses.length
      ? { verdict: "reviewable_miss", reasons: misses }
      : { verdict: "correct", reasons: [] };

const invalid = (error: Error): FeatureScore => ({
  verdict: "reviewable_miss",
  reasons: [`invalid_output: ${error.message}`],
});

export type ExpectedAudit =
  | { kind: "clean" }
  | {
      kind: "defect";
      purchaseId: string;
      /** Any of these finding kinds on `purchaseId` detects the defect. */
      findingKinds: string[];
      /** The one relink that fixes it, when a relink can. */
      relink?: { expenseId: string; productId: string };
    };

type ObservedAuditFinding = Pick<
  ImportAuditOutput["findings"][number],
  "kind" | "targetPurchaseId" | "probability" | "proposedFix"
>;

export function scoreAudit(
  expected: ExpectedAudit,
  observed: { findings: readonly ObservedAuditFinding[] } | Error,
): FeatureScore {
  if (observed instanceof Error) return invalid(observed);
  const unsafe: string[] = [];
  const misses: string[] = [];
  const target = expected.kind === "defect" ? expected.purchaseId : null;
  for (const finding of observed.findings) {
    const relink =
      finding.proposedFix?.kind === "relink_product"
        ? finding.proposedFix
        : null;
    const right =
      relink &&
      expected.kind === "defect" &&
      expected.relink?.expenseId === relink.expenseId &&
      expected.relink.productId === relink.productId;
    if (relink && !right && finding.probability >= AUTO_APPLY_PROBABILITY)
      unsafe.push(`auto_relink:${relink.expenseId}->${relink.productId}`);
    else if (relink && !right) misses.push(`wrong_relink:${relink.expenseId}`);
    if (finding.targetPurchaseId !== target)
      misses.push(`spurious:${finding.targetPurchaseId}`);
  }
  if (
    expected.kind === "defect" &&
    !observed.findings.some(
      (finding) =>
        finding.targetPurchaseId === expected.purchaseId &&
        expected.findingKinds.includes(finding.kind),
    )
  )
    misses.push("missed_defect");
  return verdictOf(unsafe, [...new Set(misses)]);
}

type RepairLine = Pick<
  ExtractedOrderCandidate["lines"][number],
  "title" | "amount" | "lineKind"
>;

export type ExpectedRepair = {
  /** `ready` when the page's own lines equal its printed total. */
  status: "ready" | "needs_review";
  printedTotal: number;
  /** Every line the page prints, adjustments included. */
  pageLines: RepairLine[];
};

type ObservedRepair = {
  status: string;
  reason?: string | null;
  candidate?: {
    printedGrandTotal: number | null;
    lines: readonly RepairLine[];
  } | null;
};

const titleWords = (title: string) =>
  title.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? [];

/** A model may retitle a line lightly, but never move its amount or role. */
const sameLine = (page: RepairLine, observed: RepairLine) => {
  if (cents(page.amount) !== cents(observed.amount)) return false;
  if (page.lineKind !== observed.lineKind) return false;
  const words = new Set(titleWords(observed.title));
  const expected = titleWords(page.title);
  return (
    expected.filter((word) => words.has(word)).length * 2 >= expected.length
  );
};

const matchesPage = (
  page: readonly RepairLine[],
  observed: readonly RepairLine[],
) => {
  if (page.length !== observed.length) return false;
  const unused = [...observed];
  return page.every((line) => {
    const index = unused.findIndex((candidate) => sameLine(line, candidate));
    if (index < 0) return false;
    unused.splice(index, 1);
    return true;
  });
};

/**
 * Score the extraction production keeps after its one repair turn (already
 * passed through `settleRepairedExtraction`, so a `ready` answer balances).
 */
export function scoreRepair(
  expected: ExpectedRepair,
  observed: ObservedRepair | Error,
): FeatureScore {
  if (observed instanceof Error) return invalid(observed);
  const unsafe: string[] = [];
  const misses: string[] = [];
  const candidate = observed.candidate;
  const pageLines = matchesPage(expected.pageLines, candidate?.lines ?? []);
  if (
    candidate?.printedGrandTotal != null &&
    cents(candidate.printedGrandTotal) !== cents(expected.printedTotal)
  )
    unsafe.push("changed_printed_total");
  if (observed.status === "ready") {
    if (!pageLines) unsafe.push("lines_differ_from_page");
    if (expected.status === "needs_review" && pageLines)
      misses.push("ready_despite_mismatch");
  } else if (expected.status === "ready") misses.push("stopped_for_review");
  else if (observed.reason !== "sum_mismatch" || !pageLines)
    misses.push("review_without_page_lines");
  return verdictOf(unsafe, misses);
}

export type ExpectedRecipeFlow = {
  /** Section 0's authored instructions, in order. */
  instructions: string[];
  /** Each listed usage's authored ingredient line. */
  usages: Array<{ usageId: string; rawLine: string }>;
  /** Instruction indexes that are environment-only setup. */
  setupInstructions: number[];
  /** [before, after]: an operation citing `after` depends on one citing `before`. */
  orderings: Array<[number, number]>;
  /** Usage ids the recipe explicitly divides between roles. */
  dividedUsages: string[];
};

export type ObservedRecipeFlowPlan = Pick<
  RecipeFlowPlan,
  "setup" | "sources" | "operations" | "walkthrough"
>;

const numbersIn = (text: string) => text.match(/\d+(?:[.,]\d+)?/gu) ?? [];

/**
 * Every displayed field may repeat only a number its own evidence states: a
 * step's cited instructions, a usage's ingredient line, a stop's operations'
 * instructions; the overview may draw on any instruction.
 */
function inventedNumbers(
  expected: ExpectedRecipeFlow,
  plan: ObservedRecipeFlowPlan,
) {
  const cited = (refs: ReadonlyArray<{ instructionIndex: number }>) =>
    refs.map((ref) => expected.instructions[ref.instructionIndex] ?? "");
  const allInstructions = expected.instructions;
  const operationRefs = new Map(
    plan.operations.map((op) => [op.id, op.instructionRefs]),
  );
  const fields: Array<{ texts: Array<string | null>; evidence: string[] }> = [
    ...plan.setup.map((step) => ({
      texts: [step.label, ...step.annotations.map(({ text }) => text)],
      evidence: cited(step.instructionRefs),
    })),
    ...plan.operations.map((op) => ({
      texts: [
        op.label,
        op.outputLabel,
        ...op.annotations.map(({ text }) => text),
      ],
      evidence: cited(op.instructionRefs),
    })),
    ...plan.sources.map((source) =>
      source.kind === "usage"
        ? {
            texts: [source.role],
            evidence: [
              ...expected.usages
                .filter(({ usageId }) => usageId === source.usageId)
                .map(({ rawLine }) => rawLine),
              ...allInstructions,
            ],
          }
        : { texts: [source.label], evidence: cited(source.instructionRefs) },
    ),
    {
      texts: [plan.walkthrough?.overview ?? null],
      evidence: allInstructions,
    },
    ...(plan.walkthrough?.stops ?? []).map((stop) => ({
      texts: [stop.title, stop.explanation],
      evidence: stop.operationIds.flatMap((id) =>
        cited(operationRefs.get(id) ?? []),
      ),
    })),
  ];
  const invented = new Set<string>();
  for (const field of fields) {
    const stated = new Set(field.evidence.flatMap(numbersIn));
    for (const text of field.texts)
      for (const value of numbersIn(text ?? ""))
        if (!stated.has(value)) invented.add(value);
  }
  return [...invented].map((value) => `invented_number:${value}`);
}

export function scoreRecipeFlow(
  expected: ExpectedRecipeFlow,
  observed: { plan: ObservedRecipeFlowPlan; issues: readonly string[] } | Error,
): FeatureScore {
  if (observed instanceof Error) return invalid(observed);
  const { plan } = observed;
  const unsafe = inventedNumbers(expected, plan);
  const misses = observed.issues.map((issue) => `invalid_plan:${issue}`);
  for (const index of expected.setupInstructions)
    if (
      !plan.setup.some((step) =>
        step.instructionRefs.some((ref) => ref.instructionIndex === index),
      )
    )
      misses.push(`missing_setup:${index}`);
  const byId = new Map(plan.operations.map((op) => [op.id, op]));
  const upstream = (id: string, seen = new Set<string>()): Set<string> => {
    for (const input of byId.get(id)?.inputs ?? [])
      if (input.kind === "operation" && !seen.has(input.id)) {
        seen.add(input.id);
        upstream(input.id, seen);
      }
    return seen;
  };
  const citing = (index: number) =>
    plan.operations.filter((op) =>
      op.instructionRefs.some((ref) => ref.instructionIndex === index),
    );
  for (const [before, after] of expected.orderings) {
    const satisfied = citing(after).some((op) => {
      const ancestors = upstream(op.id);
      return citing(before).some(
        (prior) => prior.id === op.id || ancestors.has(prior.id),
      );
    });
    if (!satisfied) misses.push(`missing_dependency:${before}->${after}`);
  }
  for (const usageId of expected.dividedUsages) {
    const roles = new Set(
      plan.sources.flatMap((source) =>
        source.kind === "usage" && source.usageId === usageId && source.role
          ? [source.role]
          : [],
      ),
    );
    if (roles.size < 2) misses.push(`undivided_usage:${usageId}`);
  }
  return verdictOf(unsafe, misses);
}
