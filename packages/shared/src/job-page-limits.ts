// Bounded application work per Job page, independent of transport limits.
export const JOB_PAGE_LIMITS = {
  maxDecisionQuestionsPerPage: 1_024,
  suggestionsPerPage: 512,
  // Generation retains complete proposals until publication finishes.
  statementGenerationPerPage: 32,
  // Each application refreshes ledger evidence; bound repeated reads between
  // durable checkpoints for import-scoped generation and labeling.
  statementApplicationsPerPage: 16,
} as const;
