/**
 * The fixed six-hour UTC window the household AI budgets (ADR 0027) and the
 * egress Durable Object's Claude credit-refusal probe share. Pure, so the
 * Durable Object reads it without the budget module's database imports.
 */
export const AI_BUDGET_WINDOW_MS = 6 * 60 * 60 * 1000;

export function aiBudgetWindow(now = new Date()) {
  const start =
    Math.floor(now.getTime() / AI_BUDGET_WINDOW_MS) * AI_BUDGET_WINDOW_MS;
  return { start: new Date(start), end: new Date(start + AI_BUDGET_WINDOW_MS) };
}

// The Workflow and the window-resume Job must release funding waits together.
const RESUME_MARGIN_MS = 60_000;

/**
 * When every funding wait resumes: just past the window boundary, when each
 * rung's window budget renews and each held refusal may probe again. A member
 * reset or paid grant wakes waiting work sooner. A refusal's own named date
 * never delays it: a later rung may fund the work first.
 */
export const fundingResumeAt = (
  windowEnd: string | Date = aiBudgetWindow().end,
): Date => new Date(new Date(windowEnd).getTime() + RESUME_MARGIN_MS);
