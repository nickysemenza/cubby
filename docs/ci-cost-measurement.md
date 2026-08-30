# CI cost and privacy measurement

Keep the repository public until a complete fourteen-day post-change window has
elapsed. Do not change visibility as part of the CI optimization change.

## Local gate acceptance

In a new worktree, install with `pnpm install --frozen-lockfile`, then time the
first `pnpm check`. It should complete within twenty seconds on the reference
machine; 22.8 seconds is the accepted initial-worktree ceiling when dependency
and compiler caches are also cold. In the same worktree, run
`pnpm benchmark:check`; six seconds remains the warm target. Record machine,
commit, minimum, median, mean, and maximum even when the target is missed so
later changes compare like with like.

`scripts/run-checks.test.ts` injects a failure into every `pnpm check` task and
proves the orchestrator reports failure without cancelling peer diagnostics.
The individual guard suites remain responsible for their domain fixtures.

## Fourteen-day Actions gate

Compare the post-change window with an equal pre-change window using rounded
job minutes, not workflow wall time. Record CI, Claude review, preview deploy,
docs, and Renovate-triggered CI separately. Acceptance requires:

- at least 75% fewer total rounded Actions minutes;
- a private-repository projection below 1,500 minutes per month;
- fewer than 10% of Codex pushes failing for a lint, format, type, generated
  artifact, affected test, PostgreSQL, E2E, or Cloudflare build issue that the
  mandatory local hooks could detect.

Do not treat cancelled jobs, GitHub incidents, runner exhaustion, or external
service failures as locally detectable regressions.

## Privacy-readiness audit

After the measurement window, verify that required checks and deployment still
work with private-repository permissions; external integrations can access a
private repository; Actions, artifact, package, and storage projections fit the
budget; Pages or public artifacts are not depending on repository visibility;
and no public link is the only copy of operational documentation. Present the
evidence and cost projection, then request explicit confirmation before changing
GitHub visibility.
