# Cubby agent rules

## Working loop

- Speed first, hands-off by default: work runs to completion with minimal
  member interaction, few tests and fast CI; [performance review](docs/agents/validation.md#performance-review)
  owns measuring speed. Ask the member only what they own (money, household
  data, product policy, Cloudflare/Neon changes); decide the rest and say what
  you decided.
- Make the requested change; preserve unrelated edits. Fix the whole class of
  bug across entities and delete what the fix replaces. When a change alters a
  documented contract, edit that contract in place in its
  [owning doc](docs/README.md#ownership-and-pruning). Add no history: no PR or
  issue numbers, dates, "no longer", cutover steps or test-coverage rationale.
  Those belong in the PR body.
- Default to no new tests, including for bug fixes. Reuse member journeys and
  dangerous-rule coverage; delete redundant, obsolete, slow and
  implementation-only tests. Test counts and one-for-one replacements are not
  goals. [Signal and speed](docs/agents/validation.md#signal-and-speed)
  owns test selection; for checks or delivery, load only the relevant
  [validation section](docs/agents/validation.md#entry-points), and before any
  typecheck, the [tsrs entry points](docs/agents/validation-quality.md#quality-and-local-diagnostics).
- Work directly by default; the member's model, lane and review choices win;
  [parallel lanes](docs/agents/validation.md#parallel-lanes) own lane briefs.
  Lanes edit disjoint files; the root agent owns final validation.
  Get one independent review, from the other provider with at most one
  re-check, only when the member asks or the change touches money writes,
  identity merges, migrations, security boundaries or concurrency. For multi-PR
  work, review the plan, not each PR. Do not enable auto-merge while that
  review is outstanding; a fix for a live production regression merges on green.
- Use synthetic data in code, fixtures, docs, commits, issues, PRs, diagnostics,
  screenshots and mockups. Exclude household records, private source material
  and real entity identifiers; preserve functional public links.
- Search with bounded `rg` and read the owning section before expanding scope.
  Save verbose logs under ignored `artifacts/`. Use absolute paths, `git -C`,
  and `pnpm --dir`; never `cd`.
- Comments record constraints, regressions, contracts and active TODOs. Use
  plain technical English. The done report is one high-level summary listing
  deletions, unverified work and, unprompted, the remaining work.
- Correct the owning rule when a mistake reveals a missing or unclear contract.
- Ship a goal as one PR unless the member names a count; their count is
  binding. Split only for independent changes, a migration or native wire
  boundary, or when the goal must iterate against production. Fewer PRs is
  better. Dependent PRs
  follow the [native PR stack workflow](docs/agents/validation.md#native-pr-stacks).
  Open PRs ready for review unless the work is incomplete or a draft is requested.
- Say "blocked" only when the member must act; waiting on CI, a review or a
  rate limit is waiting. Restoring lockfile dependencies is always allowed.
- For websites that require login, use the member's signed-in Google Chrome;
  check it before asking them to log in or export, and report it if unavailable.

## Work tracking

Search existing [GitHub Issues](https://github.com/nickysemenza/cubby/issues)
before implementation and follow the [issue workflow](docs/agents/issues.md#agent-workflow-with-gh)
for matches or backlog changes: labels, Status, and closing completed or
superseded issues in the same change. Issues own unfinished work nobody is taking up
now. Create none for work you are starting immediately, including a remainder
the member is doing next; the PR body or done report carries it.

## Breaking changes

Make the breaking change rather than a compatibility shim: change contracts in
place, update every client in the same change and carry stored data through
migrations. For API, RPC, MCP, manifest, stored-shape, or native wire changes,
load [breaking changes](docs/agents/domain-rules.md#breaking-changes).

Ask before deleting a database or resetting data. When deployment is
authorized, default to a non-graceful cutover: downtime and failed old requests
are acceptable. Merging to `main` deploys and applies migrations. Add no writer holds, maintenance windows, compatibility
rollouts, rehearsals, staged boundaries or per-PR confirmations the member did
not ask for, in code, runbooks or goals you draft; keep a drafted goal under
4,000 characters and list only the stops the member set. Preserve household
data and durable work; follow the [production migration runbook](docs/runbooks/production-migrations.md)
for transaction locks and retained queue work.

## Generic by default

Design for the two-person household and its actual data volume. Preserve user
flows, household data, source evidence and member decisions. Wrong behaviour,
including money, settlement and merge outcomes, may change with a synthetic
case proving it wrong and a line in the PR body. Reuse one owner per
responsibility; justify added machinery with a concrete failure or measured
cost. Before adding a table, column, queue, cache, runbook or audit record to
make a feature cheaper or safer, first propose deleting or shrinking the
feature. Replacing a mechanism removes its old callers, adapters and tests.

Prefer existing commands, queues, renderers and audit mechanisms. A one-off
repair does not by itself justify a permanent API, registry or
automation framework. For explicitly authorized data-only repairs, follow
[the maintenance exception](docs/agents/domain-rules.md#production-changes)
and retain preservation, read-back and replay evidence. Before proposing to
delete or replace a feature, read its ADR, its owning doc section and the
kept-on-purpose list in [ADR 0025](docs/adr/0025-radical-simplification-of-background-work.md),
then name every member-visible route, tab and surface it removes, including
those under a removed parent. No recent writes does not mean unused for
reference data.

Keep automatic eligibility checks invisible during normal use: apply supported
actions under the owning policy and leave unsupported or ambiguous cases visible
without re-prompting, preserving current evidence and explicit member decisions.
Check the data behind an automation rule before asking the member to approve it.

Reuse before writing: search [generic paths](docs/agents/generic-paths.md).
Entity behavior belongs in declarations and generic runtimes; for entity or
cross-client changes, load [declaration rules](docs/entities.md#generic-by-default).
Before adding queries or scheduling work from list rows or cells, load
[web runtime rules](apps/web/docs/web-runtime.md#list-loading-and-enrichment);
before adding override storage or precedence, [field resolution](docs/entities.md#field-resolution-and-overrides);
before adding background scheduling, consistency or repair, [Background derived data](docs/entities.md#background-derived-data).

## Load when triggered

- **Product behavior:** the binding [README tenets](README.md#tenets); error
  surfaces follow [raw diagnostics](docs/agents/domain-rules.md#error-diagnostics).
- **Architecture, commands, deployment:** the relevant heading of
  [Development](docs/development.md), not the whole file; for local scripts or
  direct JSON API calls, [local scripting](docs/development.md#local-scripting).
- **Schema, migration, locks, delete/merge, identifiers, bindings,
  repo/service boundary, WASM, or Workers:** [agent domain rules](docs/agents/domain-rules.md).
- **React, routes, browser behavior, styling, images, tables, or web UI:**
  [apps/web/AGENTS.md](apps/web/AGENTS.md). For visual/design choices, also read
  [DESIGN.md](apps/web/DESIGN.md).
- **Entity genericization, manifest/binding spine, new entities:** [docs/entities.md](docs/entities.md).
- **iOS/macOS app, `CubbyKit`, `cubby-ffi`, UniFFI:** [apps/apple/AGENTS.md](apps/apple/AGENTS.md).
- **Dev startup, readiness, toolchain or login:** [local development](docs/local-development.md#start-and-discover).
