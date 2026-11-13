// Bounded application work per Run page, independent of transport limits.
export const RUN_PAGE_LIMITS = {
  maxDecisionQuestionsPerPage: 1_024,
  suggestionsPerPage: 512,
  // Generation retains complete proposals until publication finishes.
  statementGenerationPerPage: 32,
  // Each application refreshes ledger evidence; bound repeated reads between
  // durable checkpoints for import-scoped generation and labeling.
  statementApplicationsPerPage: 64,
  // A cooperative page stops starting model work at this budget; the Pass renews its claim during work.
  cooperativePageBudgetMs: 4 * 60_000,
} as const;
