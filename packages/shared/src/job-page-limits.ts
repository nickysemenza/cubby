// Bounded application work per Job page, independent of transport limits.
export const JOB_PAGE_LIMITS = {
  maxDecisionQuestionsPerPage: 1_024,
  suggestionsPerPage: 512,
  // Each application refreshes ledger evidence; checkpoint before those reads
  // accumulate enough retained work to exhaust the Worker heap.
  statementApplicationsPerPage: 4,
} as const;
