# Validation, CI, and delivery

Default to existing coverage and the narrowest checks that verify the change.
Before adding or extending a test, apply the [retention gate](#test-retention).

Write the failure modes and any justified failing regression before the
implementation it guards. Use real implementations; mocks are for external
seams that cannot run locally. Negative fixtures must satisfy earlier admission
contracts so the observed failure reaches the intended guard.

## Entry points

Read the section for the current decision; follow its links when triggered.
Publication does not require loading every test, native-stack or performance rule.

| Decision                                           | Section                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Add, retain or delete a test                       | [Test retention](#test-retention)                                                 |
| Choose a test boundary                             | [Signal and speed](#signal-and-speed)                                             |
| Run a focused check or diagnose a failure          | [During implementation](#during-implementation)                                   |
| Run a TypeScript typecheck                         | [tsrs compiler entry points](validation-quality.md#quality-and-local-diagnostics) |
| Choose evidence for the changed behavior           | [Before opening a PR](#before-opening-a-pr)                                       |
| Commit, push, inspect CI or assess merge readiness | [Commit, push, and merge](#commit-push-and-merge)                                 |
| Capture UI evidence                                | [PR screenshots](#pr-screenshots)                                                 |
| Publish dependent PRs                              | [Native PR stacks](#native-pr-stacks)                                             |
| Brief or run parallel lanes                        | [Parallel lanes](#parallel-lanes)                                                 |
| Evaluate a performance change                      | [Performance review](#performance-review)                                         |
| Run a broad local diagnostic                       | [Explicit local diagnostics](#explicit-local-diagnostics)                         |

For prose-only changes, use the staged formatting hook and check changed links;
no typecheck, generation, build or runtime tests are required. CI still owns the
final-content merge gate. Record passing checks with the revision or inputs they
cover; reuse them until those inputs change. A new handoff, review or push alone
does not invalidate evidence.

## Signal and speed

Tests protect what members can accomplish and what data must remain correct,
while leaving the implementation free to change. Every retained test serves one
of two roles:

- **Journeys carry most product confidence.** A broad scenario drives a real
  workflow (import a wardrobe, receive a purchase, split an expense, change an
  assignment) and independently reads back the saved result. Let the agent adapt
  selectors and steps to UI changes; the stored outcome is the assertion.
- **A small set of fast, precise tests guards dangerous rules:** money
  arithmetic and settlement, identity and merge, source evidence, permissions
  and security boundaries, concurrency and queue fairness, and stored-data
  migrations. Anything else belongs in a journey or nowhere.

A stored-data migration test migrates `through` its own migration, so a later
migration cannot change what it asserts. A change adding a migration runs the
`tooling/` migration tests, which migrate past every older fixture.

Share the plumbing: seeded worlds (`tooling/factories`), isolated IntegreSQL
leases, the Worker runtime and cleanup serve every lane; do not build a separate
harness for one lane or spec. Keep local iteration narrow: run the affected
file or one journey locally, and let CI run the full catalog with cached passes.
Delete redundant tests as coverage earns trust: once a journey demonstrably
catches a regression, remove the tests that duplicate it or merely freeze
internal structure. When the suite is slow, delete slow or low-value tests
rather than adding sequencers, balancers or runners.

Choose the cheapest boundary that can expose the failure. Classify individual
cases in mixed service-backed suites: SQL elsewhere in a file does not make
every assertion an integration check. Before moving a case, read its destination
owner and preserve the existing cases. Headless HTTP/native service checks
establish stored values, totals, provenance, ownership and error contracts; a
small browser journey establishes navigation, editing and supported visible
outcomes. Deterministic read-back establishes whether the action worked.
Required native-browser previews own shared presentation and interaction
capabilities once, using production renderers and injected read responses. Keep
route composition, navigation and persisted outcomes in real E2E/HTTP journeys;
previews cannot prove server filtering or writes. See the
[coverage ownership rules](validation-tests.md#required-component-browser-tests).

## Test retention

A code change, bug fix, or new library API does not add a test by default.
A bug fix extends an existing journey or dangerous-rule test with the missing
assertion when one owns the behavior; a standalone repro is retained only for a
dangerous rule and states the failure it guards. Before adding or keeping an
automated test, establish all three:

- A concrete failure would materially affect an ordinary workflow or one of
  the dangerous rules above.
- Existing journey coverage, compiler checks, or generator guards cannot
  reasonably catch it. Name the nearest existing owner and its actual gap.
- The smallest useful regression is worth its ongoing maintenance, runtime,
  and fixture/harness cost. Reproducing a bug before a fix is evidence, not
  sufficient justification for retaining the test.

If that case is not established, make no test change. Report the existing
checks and any deliberate coverage gap. Disposable probes can establish a
refinement without becoming permanent coverage.

A journey's statement and bound-parameter ceilings go through
`expectStatementBudget` (`apps/web/tooling/statement-budget.ts`), the CI gate
for per-row database work ([performance review](#performance-review)). Assert
no other query counts, timing budgets or ratchets in tests.
Keep load generation and throughput sampling out of correctness regressions:
use the smallest fixture graph that crosses the relevant page or batch boundary,
force external admission refusals at the provider seam, and assert committed
outcomes and forbidden work directly. Fix a flake by waiting on the real
condition or delete the test; never add a retry. A test reported flaky twice is
fixed or deleted in the next PR; `test.fixme`, `skip` and quarantine count as
deletion and are removed ([CI retry mechanics](validation-tests.md#vitest-projects-and-ci-retries)).

Delete a test when it duplicates a retained journey, freezes internal
structure (declarations, constants, mocks, call order, copy, file layout),
repeats cases of one shared primitive, reproduces an old bug outside the
dangerous rules, guards performance, or spends material CI time on a rare
cold-start, legacy-recovery or harness permutation; such permutations need no
equivalent replacement. Catalog-wide "every entity" checks keep one
representative per distinct runtime path. For every deletion, record the
stronger retained regression, lack of runtime behavior, or deliberate rare-case
tradeoff in the deleting commit, and preserve consequential ordinary-workflow
regressions.

When a test earns retention, extend the existing owning workflow first. Prefer
one E2E scenario at the real user/system boundary when it covers the failure;
use an isolated test only for a material failure that boundary cannot reasonably
catch, such as a database constraint or native wire contract. Small subscription,
pending-state, presentation, and behavior-preserving refactors normally reuse
existing checks; exercising a framework primitive through mocked transport does
not by itself justify another test or required browser capability.

Library rendering smoke checks, prop forwarding, SVG node counts, exact style
attributes, and one-off migration parity checks are disposable verification:
use temporary probes, screenshots, or scripts and remove them before
committing, even when they caught an issue during development.

An accessible action name used to drive a real interaction still has value;
incidental wording is not an outcome. Do not render empty pages across the
entity catalog to compare section headings with the same declarations, and do
not eagerly import every feature to warm a catalog matrix.

Never assert the size, non-emptiness, or exact membership of a growing declared
set (the entity catalog, manifest, registries, generated output) or count a
test's own iterations: assert the per-member property instead. Do not compare
two outputs of the same generator. Hold a hand-written registry to declarations
with types, not a key-set test: `satisfies Record<GeneratedUnion, …>` in
TypeScript, an exhaustive `switch` over a generated per-status enum in Swift
(`native-coverage.ts` emits `Implemented…ID`). Pinning a documented deliberate
exception stays. Removing a registry test also removes exports that existed
only to expose its internals.

## During implementation

Rebase onto freshly fetched `origin/main` before running any typecheck,
generator, or test, and again before pushing: results from a stale base miss
migrations, generated artifacts, and ratchets (schema budgets) that main has
since changed, so they are not evidence for the merge. When the rebase brings a
lockfile or dependency change, run `pnpm install` before trusting a typecheck.

While iterating, run the named affected files or one affected E2E scenario;
[test tiers](validation-tests.md#choosing-and-running-tests) own the commands,
the Vitest report path and selector traps. For persistent HMR, fixture packs, or
runtime discovery, load [local development](../local-development.md).
Disposable E2E lanes own their test databases. The existing CI Playwright
reports and traces and local native `sim-e2e` artifacts are sufficient; no
custom bundle is required per journey.

### Builds and shared checkouts

- Reuse a healthy HMR session for iteration and Nx-cached Worker builds.
- Finish source edits, commits and staged formatting hooks before starting a web
  build, and keep the checkout unchanged through its E2E run. Nx's `build-cf`
  key is the build's content (excluding `apps/web/tests`), not the commit, so a
  commit with unchanged inputs reuses it.
- A skipped `build-cf` task does not establish fresh output. Verify the changed
  bundle and Worker config before serving it; if Nx skips the build, run
  `pnpm --dir apps/web run build:cf` directly. A focused Playwright rerun can
  then use `test:e2e:ci:desktop` against that output.
- Wait for a build's terminal success before starting a dependent Worker or
  browser check. A yielded session is still running, and a completed client
  bundle does not establish a finished Worker build.
- Finish cold artifact preparation before launching its consumers: concurrent
  wasm-pack invocations race installation of the shared wasm-bindgen CLI.
- The root agent owns generation and migration readiness during parallel work.
  In one checkout, finish checks that publish generated or declaration inputs
  before a runtime collects modules from them. Before declaring shared schema
  inputs ready, run the read-only `loadEntityDeclarationBundle` strict probe
  from an ESM entrypoint (`.mts` with `tsx --tsconfig apps/web/tsconfig.json`);
  `tsx -e` can instantiate duplicate schema modules. Do not infer readiness
  from field spelling.

### Test-speed investigations

Extract the existing GitHub reports, traces and job logs before considering a
local run, and use Nx task durations, dev-supervisor phase timings and named
GitHub steps before adding telemetry. Label cache replays and timings from
other revisions; missing timing artifacts do not justify rerunning a whole tier.
Report setup separately from scenario time; a failed build or startup check is
not a scenario result. Optimize both the PR's slowest lane and total work
contending across local sessions; moving checks to nightly is not a speed
improvement. Measure CI's natural job timings before changing shards, and keep
test-lane cache keys broad.

## Before opening a PR

Correctness and the final content's green `CI passed` are the bar; PR size and
reviewability never limit scope. A pending CI run is compatible with a
ready-for-review PR, and publication itself adds no checks.

Choose local evidence by the changed behavior:

- Web/server behavior: the affected regression or real user journey. Run one
  app typecheck when TypeScript behavior or signatures change; include the
  test program when tests/tooling change (see [quality](validation-quality.md)).
  New repository-owned modules and table/computed-SQL helpers must join the
  ownership roster in `apps/web/tooling/typecheck-repositories.ts`; composition
  imports use its alias boundary. Run the full web `typecheck`, including its
  boundary guard, for these additions: an app-only compile does not check
  resolved ownership. Run that once before commit or push, never after each
  edit, and never start a second typecheck in a worktree while one runs.
- Generated native labels, fixtures, constants, or incidental Swift changes:
  verify generation and relevant focused contracts. CI owns native compilation;
  these edits alone do not require local host tests, app builds or simulators.
- Native wire shapes or decoding: focused host/contract coverage. Compile
  locally when the change has a specific native compilation risk; CI always
  covers changed native inputs before merge.
- Hand-written Swift behavior: compile the affected target; existing CI owns
  the rest ([native validation](../../apps/apple/AGENTS.md#verification)).
- Signing, entitlements or release configuration: the relevant archive/release
  check. TestFlight builds are not an ordinary pre-PR requirement.

`pnpm apple check host`, `app`, or `lint` selects one native check;
`pnpm apple check` runs all three sequentially after artifact preparation. For
hand-written Swift edits, run `pnpm apple check lint` before opening a PR: the
staged Oxfmt hook does not format Swift, and compilation does not verify Swift
formatting. The server client-version gate test is relevant when changing
compatibility behavior, not merely because generated Swift changed.

CI selects broad tiers from their declared inputs and replays unchanged tasks
from the Nx cache; do not repeat the full PostgreSQL, lint, or build suites
locally as a gate. While iterating, lint the edited paths with
`pnpm exec oxlint <paths>` rather than `pnpm lint`; the commit hook owns staged
lint/format. Before pushing, run CI's own Knip target
(`pnpm exec nx run cubby-checks:knip`) and the fast unit suite (`pnpm test`);
a bare local `knip` or a dependency-only check reports differently from CI.
Run generator validation for changed declarations and `actionlint` for CI
workflow changes. After a dependency change, `rg registry-gateway pnpm-lock.yaml`
and strip any `tarball:` field it finds: CI rejects private registry-gateway
tarball URLs.

One root agent owns any broad validation the change needs. A subagent runs only
focused tests and returns the result, command, duration, relevant output and
limits. Reuse valid results at handoff; choose checks for the changed behavior
rather than a blanket `pnpm check` or affected suite. Keep expensive local gates
sequential, including across active sessions on a constrained host.

## Parallel lanes

Default to 3–4 lanes in parallel, at most about 5, each editing disjoint files.
Give broad multi-part lanes the stronger model and narrow mechanical lanes
Terra. Every lane brief carries an explicit done-list and the toolchain setup
([local development](../local-development.md#toolchain), plus `DEVELOPER_DIR`
for [Apple](../../apps/apple/AGENTS.md#verification) lanes). A lane pushes its
branch before long checks. A test already failing at the lane's base is
reported and does not stop the lane. The root agent watches for lanes waiting
on a question, sends partial returns back to finish their done-list, and owns
final validation.

## PR screenshots

Screenshots are optional evidence, at the author's discretion: add them when a
PR changes what a web screen looks like and an image says more than prose.
Capture against the local E2E stack, whose seeded data is synthetic, never
against production: the repository is public and attached images are too. Save
`page.screenshot({ path })` files from a throwaway Playwright spec or the
affected scenario, and delete the throwaway spec before committing. Reference
each image in the body by its local path and pass the same path to
`gh pr create --attach` or `gh pr edit --attach`; the CLI uploads it and
rewrites the reference. A before image (from `main` or a run before the first
edit) helps when the change is a comparison. Do not open the images to check
them: attaching a saved file costs no context.

## Native PR stacks

Publish dependent PRs as a native GitHub stack
([GitHub stacked pull requests](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests)).
Independent changes stay in separate PRs.

1. Open each layer against its predecessor, then register the PRs bottom to top
   before their final push, so normal PR workflows run in stack context:

   ```sh
   gh stack link --base main <bottom-pr-url> <next-pr-url>
   gh stack link <stack-number> <new-pr-url>   # append a later layer
   ```

2. Verify the native stack and member order on GitHub; chained base branches
   and T3's derived chain do not complete registration. Link each member to T3
   by its pull-request URL (the stack number identifies the stack, not a PR).
3. After changing a lower layer, rebase its dependents bottom to top. After
   resolving conflicts, run `pnpm exec nx run cubby-checks:format` before
   publishing (`git rebase --continue` skips the staged hook) and commit the fix
   normally.
4. Before reporting the stack ready, fetch the trunk and verify it is an
   ancestor of the bottom branch and each lower head is an ancestor of the
   layer above; rebase the full stack when the trunk has advanced. Read
   membership and final-head checks from GitHub. A standalone
   `workflow_dispatch` run does not establish a PR's required checks.
5. The merge gate below applies to every member. Merge the ready group with
   `gh stack merge <stack-number> --squash --yes`, preserving GitHub's atomic
   stack merge, rather than merging PRs individually.

## Commit, push, and merge

Inspect CI logs and annotations before editing. Fix only change-caused failures;
report flakes, infrastructure, and unavailable checks separately. Use an
isolated worktree when maintenance must not alter the configured checkout.
Validate deploy-only steps against CI token scopes because PR jobs do not
exercise them. After a squash merge, base independent follow-up work on current
main and inspect the base-to-head diff; a fresh branch from the old head can
reintroduce already-merged changes into the next PR.

When a shell call runs a check before dependent Git operations, stop on failure
with `set -e` or use separate calls. A failed check must not be followed by a
commit, push, or rebase continuation in the same call. Read a check's exit
status from the check itself, never through a pipe (`| tail` reports `tail`'s).
Stage explicit paths (or `git add -u` plus named new files), never
`git add -A apps`: checkouts can hold stale untracked Apple artifacts.

Commits run only staged-file Oxlint/Oxfmt through installed lint-staged;
`pnpm check:staged` runs the same entrypoint and preserves partial staging.
Target 1–2 seconds for ordinary commits. Hooks run no package managers,
dependency installation, generation, WASM, builds, typechecks, tests, or network
work. Oxfmt runs only through the staged hook, including in delegated lanes.
`pnpm install` (and so `pnpm agent:setup`) sets Git's shared `core.hooksPath` to
the relative `.husky` through the `prepare` script, so every linked worktree
runs hooks from its own checkout; exported archives without `.git` skip it. A
missing lint-staged installation fails immediately with the install command.
Confirm staged-check output; a successful commit alone is not validation
evidence. Fix reported lint issues explicitly and stage the corrections. Bypass
the hook only when the user explicitly requests it.

Authors and reviewers enforce synthetic-only outward content under `AGENTS.md`;
there is no commit-message or PR-text identifier scanner.

Checkout and merge hooks run no builds: build, test and dev entry points ensure
the artifacts they consume. Pushes run no validation and do not require a clean
working tree or a refreshed base ref. Committing, pushing, or handing off work
does not trigger additional local checks. Report local results and anything
unrun without implying that a successful push proves correctness.

`CI passed` must pass for the final PR head's content before merge. CI starts
every Linux lane and path-filters only Rust and Apple
([ADR 0020](../adr/0020-cache-routed-ci.md)). A passing result in the shared Nx
remote cache for the same input hash satisfies a started lane's check only when
the execution environment also matches; CI replays it in seconds
([ADR 0009](../adr/0009-content-hash-merge-gate.md),
[CI](../ci.md#cache-keys-and-the-remote-cache)). A check that reads a new file
belongs in its Nx target's inputs. Local Mac web tests do not replace Linux
validation, and a green earlier commit with different content is not evidence.
`main` runs CI after deployment starts, so post-merge CI does not replace this
gate. A PR that adds a migration follows the
[production change rules](domain-rules.md#production-changes), including
compatibility with the code running while the release applies it. After merge,
confirm only that the Deploy workflow succeeded, plus any check a migration
runbook or the member asks for; PR text promises no other post-deploy
read-back.

## Performance review

Speed is a goal: work that takes hours is broken. Fix every efficiency angle
in one push rather than one bottleneck per round, and reject an optimization
whose measured win is small against the layer it adds. Statement count is the
throughput budget: each Postgres round trip from a placed Worker costs about
13 ms, so batch statements per page;
[`expectStatementBudget`](#test-retention) is the CI gate, and there are no
timing gates.

Measure read-only on real production, not a copy or a synthetic fixture: open
`BEGIN READ ONLY` with a `statement_timeout`, compare `pg_stat_statements`
deltas, sample `pg_locks`, and read Worker traces with `cf` using an authenticated
profile. Check `cf auth whoami` with the default login before selecting a named
profile or requesting credentials.
Custom spans live in the `otel` dataset; query it or all datasets rather than
restricting a span query to `cloudflare-workers` logs.
Never print the database URL; ask the member for it when you have no access.
Judge a fix by whole-database load over a clean window on new code only
(background pages keep the code they started with), not by the target's own
spans. A synthetic fixture beating a target does not close an issue.

Performance changes report before/after evidence. For read paths, the
[existing read harness](../entities.md#list-reads) adds requested fields and
dependencies versus loaded work, SQL calls and plan work, response bytes, decoded operation failures, and time until
useful data is available. Label the revision, environment, workload, cache
state, and unavailable measurements. Unsupported shape metadata and unprovided
operator context stay null.

- Never use an input fingerprint as anonymization or copy arbitrary input keys
  into evidence, including private samples.
- Captured SQL can contain data-dependent dictionaries and resolved ID sets.
  Pass the same bindings to both variants.
- A query timing does not establish page latency, and HTTP success does not
  establish RPC success.
- Deployed Workers advance `performance.now()` and `Date.now()` only after I/O,
  so they do not measure synchronous CPU; subtracting a `Server-Timing` duration
  from browser TTFB does not attribute the rest. Use CPU profiles
  ([Workers timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)).
- For local built-Worker startup, await `unstable_startWorker`'s
  `reloadComplete` event (`ready` only confirms Wrangler's proxy), report
  installation separately from the first application read, and match executable
  layout, source maps and inspector setup across arms.
- Attribute repeated plan work by relation or alias and owning SQL producer; a
  shared CTE name does not establish an identical computation.

Review the shared cause before approving a local optimization: read projections,
dependency reuse, per-row SQL work, polling and concurrency ownership, browser
import dependencies, and predicate/index alignment. Extend existing projection,
report-dependency, transport, and measurement tools. Keep workload-specific
query decisions with their owning domain; share evidence collection and parsing.

Statement settlement budgets use the existing statement-budget utility and the
synthetic 1, 8 and 32 charge cases in
`domains/transaction-import/repo/statement-spending.integration.test.ts`.
They measure kernel load, fence, apply, dependency and audit phases, with a
150-statement bound for the whole page. Stored answers keep the proof offline.

## Explicit local diagnostics

`pnpm check` remains available for repository-wide static validation.
`pnpm verify:local` is the clean-tree full diagnostic, and
`pnpm verify:local:full` forces uncached verification. Use broad checks for
relevant diagnosis, an explicitly requested audit, or full local verification.

## Load when needed

- [Test tiers and browser/database traps](validation-tests.md) for a new test,
  changed `.tsx`, PostgreSQL, E2E, WASM, or package test work.
- [Quality and local diagnostics](validation-quality.md) for lint/type failures,
  dependencies, generated surfaces, or broad local verification.
