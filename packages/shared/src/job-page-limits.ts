// Bounded application work per Job page, independent of transport limits.
export const JOB_PAGE_LIMITS = {
  maxDecisionQuestionsPerPage: 1_024,
  suggestionsPerPage: 512,
  // Each application refreshes ledger evidence; bound repeated reads between
  // durable checkpoints for import-scoped generation and labeling.
  statementApplicationsPerPage: 4,
} as const;
