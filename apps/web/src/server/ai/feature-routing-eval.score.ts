import type { ImportAuditOutput } from "@cubby/schemas/purchase-import";
import type { RecipeFlowPlan } from "@cubby/schemas/recipe-flow";

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

export type ExpectedRepair = {
  /** `ready` when the page's own lines equal its printed total. */
  status: "ready" | "needs_review";
  printedTotal: number;
  /** Every line amount the page prints, adjustments included. */
  pageAmounts: number[];
};

type ObservedRepair = {
  status: string;
  reason?: string | null;
  candidate?: {
    printedGrandTotal: number | null;
    lines: ReadonlyArray<{ amount: number }>;
  } | null;
};

const cents = (amount: number) => Math.round(amount * 100);
const sameAmounts = (left: readonly number[], right: readonly number[]) => {
  const sorted = (values: readonly number[]) =>
    values.map(cents).sort((a, b) => a - b);
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
};

export function scoreRepair(
  expected: ExpectedRepair,
  observed: ObservedRepair | Error,
): FeatureScore {
  if (observed instanceof Error) return invalid(observed);
  const unsafe: string[] = [];
  const misses: string[] = [];
  const candidate = observed.candidate;
  const amounts = candidate?.lines.map(({ amount }) => amount) ?? [];
  const matchesPage = sameAmounts(amounts, expected.pageAmounts);
  if (
    candidate?.printedGrandTotal != null &&
    cents(candidate.printedGrandTotal) !== cents(expected.printedTotal)
  )
    unsafe.push("changed_printed_total");
  if (observed.status === "ready") {
    if (!matchesPage) unsafe.push("lines_differ_from_page");
    if (expected.status === "needs_review" && matchesPage)
      misses.push("ready_despite_mismatch");
  } else if (expected.status === "ready") misses.push("stopped_for_review");
  else if (observed.reason !== "sum_mismatch" || !matchesPage)
    misses.push("review_without_page_lines");
  return verdictOf(unsafe, misses);
}

export type ExpectedRecipeFlow = {
  /** Every authored instruction and ingredient line, for number checks. */
  sourceText: string;
  /** Instruction indexes (section 0) that are environment-only setup. */
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

export function scoreRecipeFlow(
  expected: ExpectedRecipeFlow,
  observed: { plan: ObservedRecipeFlowPlan; issues: readonly string[] } | Error,
): FeatureScore {
  if (observed instanceof Error) return invalid(observed);
  const { plan } = observed;
  const stated = new Set(numbersIn(expected.sourceText));
  const prose = [
    ...plan.setup.flatMap((step) => [
      step.label,
      ...step.annotations.map(({ text }) => text),
    ]),
    ...plan.operations.flatMap((operation) => [
      operation.label,
      ...operation.annotations.map(({ text }) => text),
    ]),
    plan.walkthrough?.overview ?? "",
    ...(plan.walkthrough?.stops ?? []).flatMap((stop) => [
      stop.title,
      stop.explanation,
    ]),
  ];
  const unsafe = [
    ...new Set(
      prose
        .flatMap(numbersIn)
        .filter((value) => !stated.has(value))
        .map((value) => `invented_number:${value}`),
    ),
  ];
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
