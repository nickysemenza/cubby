// Static application-path sizing, not a meter of platform subrequest usage.
// Workflow subrequests are configurable up to ten million (checked 2026-10-20).
// https://developers.cloudflare.com/workflows/reference/limits/
// Keep headroom for bookkeeping, successor dispatch and failure recovery.
const subrequests = 4_000_000;
const reservedSubrequests = 800_000;
const maxDecisionQuestionsPerPage = 1_024;
const pageAttempts = 3;
const maxPagesPerInstance = 500;
const transportOperationsPerQuestionAttempt = 16;

export const WORKFLOW_EXECUTION_LIMITS = {
  subrequests,
  maxDecisionQuestionsPerPage,
  suggestionsPerPage: 512,
  pageAttempts,
  controlWakesPerWait: 32,
  maxPagesPerInstance,
  databasePagesPerInstance: Math.min(400, maxPagesPerInstance),
  decisionPagesPerInstance: Math.min(
    maxPagesPerInstance,
    Math.floor(
      (subrequests - reservedSubrequests) /
        (maxDecisionQuestionsPerPage *
          transportOperationsPerQuestionAttempt *
          pageAttempts),
    ),
  ),
  fallbackPagesPerInstance: Math.min(20, maxPagesPerInstance),
} as const;
