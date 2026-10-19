/**
 * The fixed six-hour UTC window the household AI budgets (ADR 0017) and the
 * egress Durable Object's Claude credit-refusal probe share. Pure, so the
 * Durable Object reads it without the budget module's database imports.
 */
export const AI_BUDGET_WINDOW_MS = 6 * 60 * 60 * 1000;

export function aiBudgetWindow(now = new Date()) {
  const start =
    Math.floor(now.getTime() / AI_BUDGET_WINDOW_MS) * AI_BUDGET_WINDOW_MS;
  return { start: new Date(start), end: new Date(start + AI_BUDGET_WINDOW_MS) };
}
