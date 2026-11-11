/** How long a claim holds a Job before another worker may take it over. */
export const JOB_LEASE_MS = 16 * 60_000;

// Bounded application work per Job page, independent of transport limits.
export const JOB_PAGE_LIMITS = {
  maxDecisionQuestionsPerPage: 1_024,
  suggestionsPerPage: 512,
  // Generation retains complete proposals until publication finishes.
  statementGenerationPerPage: 32,
  // Each application refreshes ledger evidence; bound repeated reads between
  // durable checkpoints for import-scoped generation and labeling.
  statementApplicationsPerPage: 16,
  // A cooperative page stops starting model work after this long. The lease has
  // no heartbeat, so the remainder covers work already started when the budget
  // ends (provider waves, final publication and checkpoint) and the 15 minute
  // stall detector.
  cooperativePageBudgetMs: JOB_LEASE_MS / 4,
} as const;
