// Bounded application work per Job page, independent of transport limits.
export const JOB_PAGE_LIMITS = {
  maxDecisionQuestionsPerPage: 1_024,
  suggestionsPerPage: 512,
} as const;
