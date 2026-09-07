# CI cost and privacy measurement

The repository became private on 2026-08-30 after the owner completed the
visibility change. Measure fourteen complete private-repository UTC days from
2026-08-31 through 2026-09-13; evaluate the result on or after 2026-09-14.

## Local gate acceptance

In a new worktree, install with `pnpm install --frozen-lockfile`, then time the
first `pnpm check`. It should complete within twenty seconds on the reference
machine; 22.8 seconds is the accepted initial-worktree ceiling when dependency
and compiler caches are also cold. In the same worktree, run
`hyperfine --warmup 1 --runs 10 'pnpm check'`; six seconds remains the warm target. Record machine,
commit, minimum, median, mean, and maximum even when the target is missed so
later changes compare like with like.

`scripts/ci-workflow.test.ts` checks the declarative gate manifest and live
verification hooks. The individual guard suites own their domain fixtures.
Use `NX_SKIP_NX_CACHE=true` to measure execution rather than cached results.

### Recorded warm sample

On commit `2ad5ee737`, a ten-run warm sample on a Mac15,13 (Apple M3, 8 cores),
Node 26.7.0, and pnpm 10.34.1 produced:

- minimum: 6.54 seconds;
- median: 6.95 seconds;
- mean: 6.87 seconds;
- maximum: 7.01 seconds.

This is stable but does not meet the six-second warm target. Treat further
sub-second work as profiling-led follow-up, not permission to remove checks.

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

### Pre-change baseline snapshot

The provisional pre-change window is `2026-08-16T00:00:00Z` through
`2026-08-29T23:59:59Z`. It contains 2,994 workflow runs. For each run's latest
attempt, each executed runner job is rounded up independently to a whole minute;
skipped jobs count as zero.

| Category | Trigger | Runs | Executed jobs | Rounded minutes |
| --- | --- | ---: | ---: | ---: |
| CI | pull request | 474 | 4,902 | 12,162 |
| CI | push | 227 | 1,632 | 3,547 |
| Renovate-triggered CI | pull request | 131 | 1,604 | 3,156 |
| Claude review | pull request | 618 | 611 | 2,825 |
| Preview deploy | manual dispatch | 571 | 570 | 571 |
| CI | manual dispatch | 10 | 150 | 323 |
| Documentation | pull request | 185 | 185 | 185 |
| Documentation | push | 81 | 81 | 81 |
| CI | schedule | 2 | 21 | 45 |
| **Total** |  | **2,299 cost-bearing runs** | **9,756** | **22,895** |

The total is a lower bound until earlier rerun attempts are added. GitHub's
secondary API limit interrupted that refinement after 1,750 of 2,994 runs; do
not use the provisional number for the final privacy decision. On this lower
bound, the 75% reduction threshold is at most 5,723 rounded minutes for an equal
fourteen-day window. The private-usage threshold is stricter: no more than 700
rounded minutes in fourteen days projects below 1,500 minutes per thirty days.

## Private-repository audit

After the measurement window, verify that required checks and deployment still
work with private-repository permissions; external integrations can access a
private repository; Actions, artifact, package, and storage projections fit the
budget; Pages or public artifacts are not depending on repository visibility;
and no formerly public link was the only copy of operational documentation.
Present the evidence, observed failures, and cost projection.
