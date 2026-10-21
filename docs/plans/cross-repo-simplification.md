# Cross-repository simplification

Status: approved and in progress; the member confirmed the complete execution
goal. GitHub Issues remains the
backlog; this document records the cross-cutting execution design.

## Agreed direction

- Deliver one merged PR covering the ranked simplification actions, the full
  outcomes of their linked issues, and their necessary blockers. One PR is an
  explicit user requirement, overriding the default independent-PR workflow.
- Be aggressive about deleting unnecessary code, tests, states, indirection and
  duplicate implementations across the repository. Prefer a smaller coherent
  model and shared mechanisms over cosmetic file splitting or wrappers.
- Supported workflow outcomes remain the baseline. Obsolete paths, redundant
  controls and compatibility layers may disappear. Resolve substantive outcome
  removals during the interview rather than silently losing them in a refactor.
- API, MCP, native, manifest and stored-shape breaking changes are authorized.
  Update clients together and carry stored household data through migrations;
  database resets or loss of household records are not authorized.
- Prefer a direct, non-graceful breaking cutover for the single user. Temporary
  unavailability and old-client failure/update/reconnect are acceptable; do not
  add dual writes, compatibility adapters, staged fallback paths or generalized
  graceful rollout machinery. Preserve stored data and follow the existing
  migration/release runbook with the smallest necessary cutover sequence.
- Aggressively delete tests that mirror implementation, duplicate coverage,
  check declarations/constants or spend heavily on rare recovery/harness
  permutations. Retain ordinary-workflow evidence and consequential money,
  identity, data-preservation, authorization and concurrency checks under
  [validation policy](../agents/validation.md).
- Judge consolidation by removed implementations and concepts, clearer
  ownership and interfaces, net maintained-code change and measured validation
  cost. An arbitrary LOC quota or a collection of smaller files is insufficient.
- Include a repository-wide custom-tooling deletion pass: `scripts/`, shell
  entrypoints, app tooling, CI/dev launchers and their configuration and docs.
  The user wants most scripts removed where feasible. Prefer direct standard
  commands and existing tool capabilities; eliminate duplicate launchers,
  pass-through wrappers and obsolete one-off helpers. Do not merely relocate
  shell logic into TypeScript or hide script bodies in package configuration.
  Retain custom code only where it owns a necessary repository-specific
  contract that standard tools cannot express economically; justify each
  retained capability and remove its redundant alternatives.
- Established third-party dependencies may replace custom implementations at
  any layer. Evaluate actual contract fit, source/activity quality, licensing,
  runtime/platform footprint and upgrade burden. Prefer a dependency when the
  adoption deletes meaningful bespoke code or concepts; remove the replaced
  implementation and wrappers rather than maintaining parallel paths.
- Sol owns architecture, migrations, integration and final validation. Astra
  assists scope discovery and adversarial planning. Use Luna for precise,
  independently checkable mechanical implementation where cost-effective; this
  explicit user choice overrides the default model-routing restriction.

## Scope discovery

Seed issues from the ranked actions:
[2125](https://github.com/nickysemenza/cubby/issues/2125),
[2304](https://github.com/nickysemenza/cubby/issues/2304),
[2280](https://github.com/nickysemenza/cubby/issues/2280),
[2857](https://github.com/nickysemenza/cubby/issues/2857),
[2251](https://github.com/nickysemenza/cubby/issues/2251),
[2248](https://github.com/nickysemenza/cubby/issues/2248),
[2414](https://github.com/nickysemenza/cubby/issues/2414),
[2749](https://github.com/nickysemenza/cubby/issues/2749), and
[2562](https://github.com/nickysemenza/cubby/issues/2562).
Include the shared native photo thermal/power observer and the repeated Run
controller reader found in the source report. Discovery adds required children
[#2249](https://github.com/nickysemenza/cubby/issues/2249) and
[#2250](https://github.com/nickysemenza/cubby/issues/2250): eleven open issue
outcomes in total. Complete all six child-review lifecycles, the full cross-client
identifier outcome and all 28 baseline list-scaffold instances. Closed blockers
are evidence to verify, not new work to repeat. Related issues are not absorbed
without an actual prerequisite contract. Astra owns discovery evidence under
ignored `artifacts/code-health/planning/astra-*`; Luna's tooling evidence lives
beside it in `luna-tooling-inventory.*`.

## Discovered constraints

- Existing stale selection already includes file imports. Reconciliation fails
  at the purchase-agent-specific scope loader; fix generic Run control and
  preserve the narrower scope for agent execution rather than add a sweeper.
- The current unified Suggestions queue supersedes the retired `/ai` Review
  tab named in #2280. Integrate child-row review into the current surface.
- Child storage does not imply entity identity or editability. Shared child-row
  reads require explicit opt-in identity/navigation and workflow commands;
  preserve distinct domain lifecycles.
- #2749's replacement deployment and queue drainage are verified. The read-only
  provider check observed zero unacknowledged messages and bytes twice; the
  live consumer has no dead-letter queue. Retired producer references are absent.
  Provider counts are best-effort point-in-time evidence, not an application ledger.
- The tooling inventory contains 179 non-test files and 92 tests across its
  scoped directories, including five `.sh` files. These are not 179 standalone
  CLIs. A reachable script is not automatically a capability worth retaining.
- The original report is a fixed source baseline. Refresh main before
  implementation, reconcile the inventories once, and compare all categories
  consistently so moving code cannot masquerade as deletion.

## Resolved behavior and scope choices

- Fail genuinely abandoned file-import Runs using the existing inactivity
  policy; preserve committed rows, recheck liveness at transition and fence
  late completion from reviving cancelled or expired Runs.
- Identifier Add preserves other values and the current primary. An empty slot
  may select its first value as primary. Replace/Remove targets an explicit
  expected value; Make primary demotes without discarding. Preserve provenance
  and use GTIN when observed encoding is unknown.
- Review every oversized module and crowded folder for real consolidation.
  Numeric limits are diagnostic signals, not acceptance targets; do not split
  coherent declarations or relocate files merely to meet a count. This is the
  user-approved interpretation of #2304's full outcome.
- Optional developer conveniences and custom enforcement gates may be dropped
  instead of reproduced. Prefer standard build/test/release commands and
  established dependencies; keep custom code only for necessary behavior they
  cannot reasonably provide.
- Include database triggers and the surrounding write/derived-state machinery
  in architectural simplification. Trace each trigger to its actual invariant
  or projection responsibility, callers, repair logic and regression evidence.
  Prefer standard database constraints and one clear write owner where they
  suffice; remove duplicated propagation, hidden side effects and obsolete
  derived triggers. Do not move the same complexity into hooks or a new generic
  framework. Verify delivered #2841 changes before proposing them again.

## Target architecture and execution order

1. Root refreshes main, reconciles inventories and prerequisite evidence, and
   records the failure/retention map. Audit every baseline test and current
   tooling capability; preserve meaningful outcomes, not custom mechanisms.
2. Root establishes one effective compiler specification shared by loading and
   compilation. Derive field availability, defaults and explicit omissions
   from readable projections. Remove parallel interpretation and redundant
   declarations rather than add an equivalence layer.
3. Root establishes declarative row mapping in the existing list runtime.
   Preserve scalar versus selected-ID relation reads, authoritative page/count/
   order and explicit field readiness. Migrate all 28 scaffold instances;
   narrow injected domain computations remain where genuinely needed.
4. Opt-in child UUID identity/navigation and named workflow commands cover
   AssessmentState, RunFinding, RunApproval, PhotoGroupProposal, PhotoRunImage
   and StatementRow. Reuse current Suggestions/Run/statement surfaces and
   family handlers; no universal lifecycle enum or automatic child CRUD.
5. Root settles explicit identifier collection intent, then all producer/client
   adoption follows the same contract. Photo review becomes a thin consumer of
   server review state and shared read/identifier/field controls, preserving
   decisions and saved/proposed evidence while deleting duplicate local state.
6. Run owns agent-independent control and the shared controller reader; agent
   execution retains narrower session enforcement. Reuse existing stale
   scheduling. Share native notification-token lifetime without a new scheduler.
7. Consolidate all issue-named oversized modules/folders after shared seams
   remove their duplication. Retire custom stack preflight, changed-test
   selection, rigid layout gates and redundant launch/cache/probe mechanisms
   where standard commands suffice. Use one task/cache owner, initially Nx;
   preserve necessary artifact assembly, isolation and build correctness.
8. Audit triggers with their callers. Keep small identity, live-endpoint and
   immutable-history enforcement where they are the simplest complete owner.
   Consolidate field Assessment publication into the existing atomic writer
   after proving all producer coverage, then delete synthesis machinery.
   Trace mail lifecycle before choosing its single owner. Reuse the delivered
   derived-refresh pipeline; remove duplicate propagation, not its guarantees.
9. Finish caller/config/docs removal, data-preserving migrations and client
   updates. Verify retired statement-task drainage before deleting its schema
   and handler. Execute the smallest direct cutover; no graceful coexistence.
10. Freeze source writers for final generation/build-dependent validation;
    obtain required independent reviews, satisfy final-content CI, merge the
    single PR and complete required release preservation read-back.

## Ownership and checks

Root Sol owns shared schema/compiler/collection/list contracts, migrations,
CI/package configuration, canonical docs, generated outputs, integration and
final validation. Sol feature lanes receive disjoint exact file lists after
contracts settle. Luna receives approved mechanical migrations/deletions with a
sample, explicit allowed paths, retained checks and escalation conditions. At
most two implementation lanes run on the host. Shared-file handoffs are serial.
The detailed initial assignments are research evidence in
`artifacts/code-health/planning/astra-round2-execution.json`, not write grants.

Root selects the cheapest real boundary for each consequential failure. Retain
ordinary web/native edit/review/scan evidence and focused money, identity,
preservation, authority, concurrency, compiler-invalid-input and native wire/
lifetime checks. Delete redundant and rare low-value coverage with its explicit
tradeoff; do not replace it with a new test framework. Existing compiler,
database, build and final-content CI guarantees must remain meaningful.

Run owning generation and the strict declaration probe, one integrated app/test
typecheck, focused changed DB/HTTP/web/native checks, Swift lint/build as needed,
and migration/catalog preservation when applicable. Knip covers changed
entrypoints/dependencies; actionlint covers workflow changes. Reuse valid lane
results; do not repeatedly run broad local suites. Source review is by a model
distinct from implementation; migration/infrastructure changes add the required
second review. Screenshots are optional evidence under validation policy.

## Engineering preflight and done evidence

- Verify replacement tools/dependencies against first-party docs and actual
  platform/CLI contracts before adoption. No paid mandatory host service or
  runtime switch is assumed. An externally supplied test-only service is an
  acceptable simpler alternative to automatic shared-service supervision.
- Complete test/tooling deletion dispositions and identifier/publication writer
  coverage before mechanical deletion. Keep temporary audit evidence ignored;
  deleting commits name retained protection or the accepted tradeoff.
- Establish queue drainage and stored/projection preservation with actual
  evidence; do not purge household work or treat a source edit as a data repair.
- Map all eleven issue outcomes and eight actions to implementation, deletions,
  owner docs and validation. Cover all six child lifecycles, 28 scaffolds and
  identifier examples/producers/consumers. Fixes references require full outcome
  completion; related issues are not closed merely because their code was read.
- Report actual net authored production/test/tooling changes using consistent
  categories, removed mechanisms and available check-cost evidence. Moving code
  to generated output/configuration is not deletion. The rough 100–200k LOC
  planning range is neither measured savings nor an acceptance quota.
- Finish only after the PR is merged at verified content, findings are resolved,
  and any required preservation/client-delivery evidence is recorded.

## Proposed execution goal

Deliver and merge one giant Cubby PR completing all eight ranked simplification
actions and every outcome of #2125, #2304, #2280, #2857,
#2248/#2249/#2250/#2251, #2414, #2749 and #2562, plus verified necessary blockers.
Aggressively delete low-value tests, duplicate implementations, obsolete paths
and custom scripts/tooling across the repository. Consolidate compiler facts,
declared reads, all six child-review lifecycles, photo state, Run control,
cross-client identifiers, native observers and justified database propagation;
adopt verified standard tools or high-quality dependencies where they reduce
total maintenance. Preserve supported household outcomes and stored data through
a direct breaking cutover without compatibility machinery. Root Sol owns
architecture, migrations, integration and final validation; use Sol for semantic
work and Luna for bounded mechanical batches. Require meaningful workflow and
preservation evidence, independent review, final-content CI, the single merged
PR and necessary release read-back. Report actual deletions and net code/check
cost changes without treating the LOC estimate as a quota.

The execution goal is active. Root records temporary evidence under ignored
`artifacts/simplification/`; GitHub Issues remains the outcome backlog.

Record durable architectural tradeoffs in their owning ADR only when resolved;
update domain terminology only when its meaning changes. Delete this plan after
completion under [documentation ownership](../README.md#ownership-and-pruning).
