# CI execution capacity

Status: **pilot implementation in progress**, tracked in
[#2538](https://github.com/nickysemenza/cubby/issues/2538). The interview has
established the outcomes and pilot shape below. Sizing and AI gate promotion
depend on measured pilot evidence. This document describes a proposal, not
current CI behavior.
[CI](../ci.md) owns the implemented contracts. No new ADR is needed until a
lasting architectural tradeoff is resolved.

## Agreed direction

- Aim for roughly five minutes to required CI success on typical web changes
  that rerun checks. Include runner queueing in the measurement: contention
  between simultaneous PRs is the main problem, not just one run's duration.
  Benchmark five simultaneous full PR runs, rather than just one isolated run.
- Prefer retaining personal repository ownership. Organization-only managed
  runners are not the preferred route; a repository transfer is not authorized.
- Start around $20 per month of external compute. Model API charges are
  separate and do not constrain this compute design. Use Boat's included
  balance and spending controls rather than implementing a billing ledger.
- Select Boat for the pilot, with one GitHub coordinator per PR. Fall back to
  ordinary GitHub execution for unavailable capacity, exhausted balance and
  Boat infrastructure failures; a failed application test remains a failure.
- Preserve a simple executor switch that routes new runs directly to GitHub.
  Turning Boat off must not require restructuring the workflow or test suite.
  Stopping CI usage and cancelling the provider subscription are separate
  operations: disabling execution alone does not cancel monthly renewal.
- Run web AI E2E alongside deterministic checks where practical. The intended
  end state is a small required smoke set if it becomes fast and reliable
  enough. Broader AI exploration remains opt-in. Existing AI journeys remain
  informational during the pilot; promotion requires reviewing measured
  latency and reliability, not merely a successful infrastructure migration.
- Use fresh per-run machines from prepared snapshots, grouping isolated shards
  within each machine. Do not introduce a retained running pool unless pilot
  evidence establishes that fresh-machine start limits are the bottleneck.
- Opt selected PR runs into the pilot first. Make Boat the ordinary executor
  only after verifying matched coverage, reporting, cancellation, fallback and
  the five-PR concurrency target.
- Keep exact-revision evidence, meaningful regression coverage and useful test
  reports when changing execution infrastructure.

## Terms for this design

A **shard** is a partition of test work. A **sandbox** is a machine executing
one or more shards. A **GitHub job** is a workflow scheduling and reporting
unit. These counts are independent: ten shards do not necessarily need ten
sandboxes or ten GitHub-hosted jobs. These are infrastructure terms; the root
household taxonomy glossary is not their owner.

**Time to green** includes time waiting for execution capacity, setup, checks
and required aggregation. Report queue time and execution time separately so
that a faster test command cannot hide worse contention between PRs.

## Constraints verified during the design

Standard GitHub-hosted runner compute for public repositories is free, while
larger runners are charged. Hosted concurrency is account-plan dependent and
shared across active work; free compute does not imply unbounded execution
capacity. [Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[concurrency limits](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners).

Moving each shard to Boat while leaving one GitHub-hosted job waiting on each
would retain the hosted slot demand. A proposed Boat design must instead use a
small number of coordinator jobs, or execute GitHub jobs on separately managed
runners. One coordinator still requires a hosted slot unless it runs elsewhere.
This follows from Boat's documented GitHub-hosted CLI invocation model:
[CI guide](https://docs.boat.dev/ci).

Boat's $20 plan advertises 100 simultaneous sandboxes but only 12 starts per
minute, 60 per hour and 200 per day. Create, fork and resume count as starts.
At ten fresh sandboxes per full run, six runs consume the entire hourly start
allowance before retries and other work. Grouping shards or retaining running
machines trades resource contention and idle billing against start demand.
[Boat limits](https://docs.boat.dev/ci#many-jobs-at-once-start-limits).

The $20 subscription alone is not a strict dollar cap. Boat supports optional
auto-refill, and its billing guide documents a 24-hour zero-balance grace period
whose extra usage is deducted from the next payment. Leave auto-refill disabled,
check capacity/balance before remote execution, and fall back when no balance
remains. Bound remote work and clean up sandboxes; do not rely on the provider
immediately terminating running work at zero. This is a control design, not a
claim that a worst-case $20 ceiling has been established. Cancelling renewal
leaves access through the paid period.
[Credits and running out](https://docs.boat.dev/billing),
[subscription cancellation](https://docs.boat.dev/billing/plan-changes#cancel-the-plan).

Managed GitHub runner eligibility is a selection criterion because this
repository is personal-owned. Depot's GitHub runners, Blacksmith and WarpBuild
document organization requirements; Depot CI is a separate product that accepts
personal repositories. Selecting those managed runners may therefore require a
repository ownership decision, not just a runner-label change.
[Depot](https://depot.dev/docs/github-actions/overview),
[Blacksmith](https://docs.blacksmith.sh/introduction/quickstart),
[WarpBuild](https://www.warpbuild.com/migrate/blacksmith-to-warpbuild#prerequisites).

## Pilot execution contract

One GitHub-hosted coordinator owns remote Linux work for a PR. It uses the
existing routing decision and existing check targets, allocates fresh Boat
machines, dispatches isolated shards, and collects results. It does not create
a hosted waiting job for each shard. Native work stays on macOS. Initially,
checks that are not part of the selected remote work retain their current
execution path; report their hosted slot demand in the five-PR benchmark too.

The initial implementation is the separate informational
`boat-ci-pilot.yaml` dispatch, comparing all selected Linux task families without
modifying the required gate's job graph. Keep trial limits: at most two
default-size (4 CPU/8 GB) machines and no billing change. Grouped jobs run
sequentially within each machine and get separate worktrees. Ordinary PR
execution continues on GitHub; automatic per-PR routing waits for pilot evidence.

Keep test commands independent of the executor. A repository-level executor
setting provides an immediate route to ordinary GitHub execution for new runs;
unset settings, missing Boat credentials and fork PRs use GitHub. Selecting
GitHub must not contact Boat or require its CLI, credentials or snapshot. Turn
off the executor before cancelling the Boat subscription. Let work already
running finish within its existing deadline, or cancel it through ordinary
workflow cancellation; disabling new starts alone does not erase running cost.

Each remote run uses the exact revision selected by the current CI contract.
Snapshots prepare tools and dependencies, not evidence that the current source
passed. Preserve the Git metadata required by provenance checks; Boat's simple
source-upload recipe alone is not sufficient proof. Reconcile dependencies
against the current lockfile. Reuse generated files and Worker builds only
after existing provenance checks establish matching inputs and environment.
Continue to key Nx results on execution identity, shard selection and actual
commands, including worker count; never relabel a Boat pass as a GitHub pass.

Each concurrent shard owns isolated database/runtime state, ports and report
paths. Share immutable prepared inputs, not mutable test state. Keep browser
binaries outside Boat's excluded cache directories. Wait for actual database
and runtime readiness rather than trusting the sandbox's ready status alone.
Named snapshots hold synthetic fixtures and tool state, never run credentials.

The coordinator streams logs with shard labels, collects existing diagnostic
artifacts and Playwright blob reports, and produces a merged HTML browser
report. Preserve the existing harness provenance/evidence contract when adding
blob reports. Database checks publish structured results; AI retains its
existing synthetic evidence and usage metrics. Summaries identify revision,
executor, cache replays, queue/setup/scenario durations and fallback reason.

Required aggregation fails closed: every selected shard must have a verified
pass or a valid existing cached pass. Missing reports, coordinator crashes and
cancelled work do not become successful or routing-skipped checks. Preserve
known test failures even if later infrastructure breaks; an exit code or report
establishing a test failure must not be reclassified to obtain a fallback pass.

Unavailable capacity, rejected starts, exhausted balance and transport or
machine failures can trigger bounded GitHub fallback. Stop remote work before
launching its replacement where possible, retain diagnostics from both, and
bound any cleanup that cannot reach Boat with remote auto-stop deadlines.
Choose one documented startup budget during implementation, then fall back
rather than retrying indefinitely. User cancellation and superseded PR runs
clean up without starting fallback work. Test failures and test timeouts are
not infrastructure fallback triggers.

## Evidence before changing defaults

Compare the same source and coverage on GitHub and Boat. Distinguish valid
cache replays from actual executions, and cold preparation from prepared runs.
Measure total turnaround under five simultaneous PR runs, plus the separate
queue, setup, build, scenario, aggregation and cleanup phases. Verify test
collection/partition completeness and retain the existing named regressions.

Start with the current two-worker browser command when comparing shard counts;
measure alternative worker counts separately. Compare modest and larger shard
counts, then select the smallest machine/shard arrangement that meets the goal
without moving contention into machine resources or Boat's start allowance.
No particular shard count or provider-specific speedup is established yet.

Exercise known test failures, missing shard evidence, provider startup failure,
exhausted balance, cancellation and the executor-off path. Verify preserved
failure status, bounded cleanup and successful ordinary GitHub execution where
fallback is appropriate. Do not repeatedly run broad suites just to test
orchestration failures; use focused injected failures at the provider seam.

Review pilot evidence before making Boat the default. Separately review the
small AI smoke roster and its latency/reliability before requiring it. This
keeps promotion criteria visible rather than implicitly equating a working
Boat integration with a reliable AI merge gate.

## Implementation ownership

The main agent owns the coordinator, workflow/routing changes, result and cache
contracts, documentation updates and final validation. Development and focused
checks run on the local checkout; remote pilot executions run on Boat, and the
fallback runs on standard GitHub runners. Keep edits in one lane. Before
implementation, recheck existing issues and create or attach the canonical
backlog item under the issue workflow. Use the required independent reviews
for CI infrastructure changes before merge. Once implemented, move durable
contracts into the owning CI and Tester Army docs and remove this proposal.
