# Cubby agent rules

## Working loop

- Make the requested change; preserve unrelated edits. Update the behavior's
  [owning doc](docs/README.md#ownership-and-pruning) in the same change.
- Default to no new tests, including for bug fixes. Reuse member journeys and
  dangerous-rule coverage; delete redundant, obsolete and implementation-only
  tests. Test counts and one-for-one replacements are not goals.
  [Signal and speed](docs/agents/validation.md#signal-and-speed) owns test
  selection and deletion rules.
- Reuse existing coverage. For test choice, checks, or delivery, load only the
  relevant [validation section](docs/agents/validation.md#entry-points).
  Before any TypeScript typecheck, load the
  [tsrs compiler entry points](docs/agents/validation-quality.md#quality-and-local-diagnostics).
- Work directly by default. Before delegation or selecting independent review,
  load [model routing](docs/agents/model-routing.md). Preserve explicit user
  model choices and the current main session; keep edits disjoint.
- Use synthetic data in code, fixtures, docs, commits, issues, PRs, diagnostics,
  screenshots and mockups. Exclude household records, private source material
  and real entity identifiers; preserve functional public links.
- Search with bounded `rg` and read the owning section before expanding scope.
  Filter tool results before returning them; save verbose logs under ignored
  `artifacts/`. A truncated dump requires targeted read-back. Use absolute
  paths, `git -C`, and `pnpm --dir`; never `cd`.
- Comments record constraints, regressions, contracts and active TODOs. Use
  plain technical English. The done report lists deletions and unverified work.
- Correct the owning rule when a mistake reveals a missing or unclear contract.
- Finish a usable baseline before expanding adjacent capabilities. Keep the
  delivery reviewable; consolidate tightly coupled work rather than accumulating
  a large dependent PR stack.
- Use Google Chrome for websites that require login, reusing the member's
  signed-in session. Check Chrome before asking the member to log in or export
  a document; if Chrome is unavailable, report that blocker.

## Work tracking

Search existing [GitHub Issues](https://github.com/nickysemenza/cubby/issues)
before implementation. For matches or backlog changes, follow the
[issue workflow](docs/agents/issues.md#agent-workflow-with-gh), including Project
fields, issue bodies and PR attribution. Issues own unfinished work; do not
create one for work you are starting immediately.

## Breaking changes

Ask before deleting a database or resetting data.

When deployment is authorized, default to a non-graceful cutover: downtime and
failed old requests are acceptable. Do not require a writer hold, maintenance
window, or compatibility rollout. Preserve household data and durable work;
follow the [production migration runbook](docs/runbooks/production-migrations.md)
for transaction locks, retained queue work, and post-deployment verification.

Change contracts in place and carry stored data through migrations. For API,
RPC, MCP, manifest, stored-shape, or native wire changes, load
[breaking changes](docs/agents/domain-rules.md#breaking-changes).

## Generic by default

Design for the two-person household and its actual data volume. Preserve user
flows, money, source evidence and member decisions. Reuse one owner per
responsibility; justify added machinery with a concrete failure or measured
cost. Replacing a mechanism removes its old callers, adapters and tests.

Prefer existing commands, queues, renderers and audit mechanisms. A one-off
repair does not by itself justify a permanent API, registry or automation
framework. For explicitly authorized data-only repairs, follow
[the maintenance exception](docs/agents/domain-rules.md#production-changes)
and retain preservation, read-back and replay evidence.

Keep automatic eligibility checks invisible during normal use. Apply supported
actions under the owning policy; leave unsupported or ambiguous cases visible
without repeatedly prompting the member. Preserve current evidence and explicit
member decisions when automating.

Reuse before writing: search [generic paths](docs/agents/generic-paths.md).
Entity behavior belongs in declarations and generic runtimes; for entity or
cross-client changes, load [declaration rules](docs/entities.md#generic-by-default).
For list loading or enrichment, load [web runtime rules](apps/web/docs/web-runtime.md#list-loading-and-enrichment)
before adding queries or scheduling work from rows or cells.
For inherited values or overrides, load [field resolution](docs/entities.md#field-resolution-and-overrides)
before adding storage or precedence logic.
For background work or derived data, load
[Background derived data](docs/entities.md#background-derived-data) before adding
scheduling, consistency or repair behavior.

## Product constraints

Read the binding [README tenets](README.md#tenets) before changing product
behavior. For error surfaces, follow [raw diagnostics](docs/agents/domain-rules.md#error-diagnostics).
[Development](docs/development.md) owns architecture, commands and deployment.
Read the relevant heading, not the whole reference.
For local scripts or direct JSON API calls, load
[local scripting](docs/development.md#local-scripting).

Use one owning skill; add another only for a distinct concern. Use the skill
catalog's task triggers; app rules below own UI skill selection.

## Load when triggered

- **Schema, migration, delete/merge, identifiers, repo/service boundary, WASM,
  or Workers:** [agent domain rules](docs/agents/domain-rules.md).
- **React, routes, browser behavior, styling, images, tables, or web UI:**
  [apps/web/AGENTS.md](apps/web/AGENTS.md). For visual/design choices, also read
  [DESIGN.md](apps/web/DESIGN.md).
- **Entity genericization, the manifest/binding spine, or new-entity work:**
  [docs/entities.md](docs/entities.md).
- **iOS/macOS native app, `CubbyKit`, `cubby-ffi`, or UniFFI:**
  [apps/apple/AGENTS.md](apps/apple/AGENTS.md).

Use the [native PR stack workflow](docs/agents/validation.md#native-pr-stacks)
for dependent PRs. Keep independent changes in separate PRs.

Open PRs ready for review unless the work is intentionally incomplete or the
user asks for a draft.

For dev startup, readiness, login, or Cursor Cloud, load
[local development](docs/local-development.md#start-and-discover).
