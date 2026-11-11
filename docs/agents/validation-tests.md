# Test tiers and runtime traps

[Validation policy](validation.md) owns test selection, retention, failure-first
evidence and delivery. This page owns how to run tests, the runtime traps that
make them fail for the wrong reason, and the shared fixtures.

Record per-test retention, deletion and coverage-gap reasons in the commit or
PR, not in this file. The test files show which owner covers a behavior.

## Choosing and running tests

- Run named files from the repository root with `pnpm test:file src/...`
  (paths relative to `apps/web`), PostgreSQL contracts with
  `pnpm test:postgres src/...`, and browser specs with `pnpm test:e2e <spec>`.
  Do not use Vitest's `related` or `run --changed`: selecting and running in
  one process has caused false `ui` failures.
- Pass flags without `--` (`pnpm test:postgres src/... -t 'case'`,
  `pnpm db:generate --name=x`, `pnpm test:e2e <spec>`): an extra `--` reaches
  Vitest as a literal separator and the filter does not apply.
- Verify every named path exists before invoking a runner: Vitest can ignore a
  nonexistent selector when another supplied file matches. For a named case,
  copy the exact replay selector or confirm the literal title with `rg`; a
  title inferred from a task description can select nothing.
- Read failures from `apps/web/.vitest-results.json` before deciding what to
  change; do not rerun an unchanged tier to rediscover them. Local Vitest runs
  share that path across projects, so serialize them until the previous report
  has been read or copied to an ignored artifact.
- Report only the files and cases the run exercised. Skipped, pending and
  empty selections are not validation evidence.
- Do not overlap PostgreSQL and E2E locally: they contend for containers,
  workerd, browsers and database connections. For changed workspace packages,
  run the affected package test; a cross-package contract change may need its
  consumers too.
- Test subprocesses invoke Node or the installed tool directly and inherit the
  needed parent environment. Never invoke a package manager from a test: its
  dependency verification can install or prune modules under concurrent suites.
- Run the web `typecheck` after the final test fixture or query edit, even when
  the runtime test passes. `typecheck:app` excludes every test file, including
  browser previews.
- Keep database regressions scoped to the failure: one sort/page-boundary case
  establishes stable order without enumerating every field and direction.

## Vitest projects and CI retries

`pnpm test` runs the fast projects (`unit`, `mcp-contract`, `ui`,
`capability`, `scripts`, `packages`). `integration` and `workers` need
services; CI's `vitest-ci` target runs every merge-gate project. `preview` is
opt-in; `live-eval` is never part of the gate.

CI retries a failed Playwright test, or a failed test in a service-backed
Vitest project (`integration`, `capability`, `preview`, `workers`), once.
Node unit, UI, tooling and package projects never retry, and nothing retries
locally. A test that passes only on retry is reported flaky. The second time a
test is reported flaky, fix or delete it; record the named failure and the
deleting commit in a GitHub issue so it can be restored once fixed. Do not skip
it in place, and never raise the retry count.

## Vitest runtime traps

- `fsModuleCache` does not key on `import.meta.glob` matches. After a merge or
  branch switch adds or removes matched files, a missing loader (for example
  `No operation module loader` from `operation-handlers.server.ts`) can be a
  stale transform. Run `pnpm --dir apps/web exec vitest --clearCache` before
  diagnosing it, and never weaken loader admission.
- Browser preview discovery stays under `src/`. Workspace symlinks in
  `node_modules` can lead back to the repository or old worktrees and must not
  become duplicate entries.
- The `ui` project shares module state between files. Its teardown clears
  Sonner notifications as well as React trees.
- Auth configuration tests await each constructed instance's `$context` inside
  the invocation that supplied its bindings. Better Auth starts async plugin
  initialization; checking only synchronous options leaves work running when
  Vitest closes its console. Do not suppress console errors or add delays.
- Keep pure logic imported by standalone Node subprocesses in alias-free `.ts`
  files; Vitest applies the app aliases, subprocesses do not. Temporary
  subprocess workspaces declare their module type. Build-provenance fixtures
  clone their synthetic Git template with Git rather than copying `.git`.
- Decision-batching model fixtures answer by question ID, not enumeration
  position; reverse the returned order to exercise keyed routing.
- MCP budget-policy tests wait for the in-memory SDK handler to start, then
  advance a fake clock across thresholds. A wall-clock sleep turns a busy CI
  event loop into false timeouts. Drain late work before restoring real time.
- Daily aggregation fixtures keep same-day rows on one recent household day;
  wall-clock minute offsets can straddle midnight.
- A virtualized table mounts only its window (the jsdom harness supplies real
  viewport dimensions); fixtures asserting every row must fit it.
- Direct component tests of feature-backed pickers call `installFeatures()`
  from `~/features/registry` themselves.
- Upload and photo-finalization tests running in Node configure
  `captureBackgroundQueue`. Image processing always schedules work; assert the
  durable jobs and captured wakeups, and drain only when the scenario needs the
  consumer. Do not suppress the queue with persisted settings.
- When adding editable fields, complete editor-test record baselines including
  nullable output projections, and run the untouched-submit regression: an
  absent baseline makes an untouched form look changed. Optional nested form
  controls stay unmounted until requested, because mounting a numeric
  controller can turn a null parent into a dirty object.
- When removing shared UI bindings, render every affected header branch or run
  the app typecheck; helper tests and lint do not prove the header renders.
- Detail renderer tests assert the continuous page (every section reachable,
  empty sections keep headings and actions); a section matrix renders once per
  entity.

## Required component-browser tests

The `capability` Vitest project runs the roster in `requiredCapabilityTests`
(`apps/web/vitest.config.ts`): production renderers in headless Chromium with
the real Tailwind CSS. It is part of `pnpm test` and the CI Vitest shards,
which install Chromium first. Other `**/*.preview.test.tsx` files stay opt-in
through `pnpm --dir apps/web test:preview` and are not merge-gate coverage until
added to the roster. Select a required owner with
`pnpm test:file <path> --project capability`; otherwise a workspace link can
also match the optional `preview` project. CI shards upload browser failure
attachments (`.vitest/attachments/`) for the merged report.

Shared list, table, card, detail and photo-review presentation has one owner
here: populated, empty and loading states, responsive layout, overflow, focus
and interaction state. Use actual declarations, column modules and renderers
with schema-valid responses through the existing operation seam. Record
outbound requests; do not build a second filter engine. A capability matrix
replaces route × viewport × state copies. Native previews keep real layout,
media queries, scrolling and observers.

Keep server inclusion and exclusion, full-filter totals and stored effects at
the real HTTP or PostgreSQL boundary, and keep a small real-browser composition
suite for navigation, history, inspectors, grouped loading and retry, asset
rendering and consequential edits. Component responses cannot establish those.
Use the `ui` jsdom tier for a failure that does not need native browser
behavior; do not cover the same capability in both tiers.

Disclosure previews wait for visible content after opening: the body mounts
before its entrance opacity transition finishes.

## Playwright E2E

### Build and serve

- Playwright and the workerd harness serve the built Worker. Nx's
  `@cubby/web:build-cf` alone decides whether it is current (a content-keyed
  cache hit or a rebuild). `pnpm test:e2e` and the browser Nx targets run it
  first; `test:e2e:ci:desktop` does not, so run
  `pnpm --dir apps/web run build:cf` after source changes before a focused
  replay with that script. A harness never rebuilds.
- There is no per-worktree harness lock: a rebuild while another suite in the
  checkout runs replaces the Worker under it, so finish edits first. The only
  machine-wide lock (`apps/web/tooling/dev-services/harness-lock.ts`,
  `/tmp/cubby-native-device`) serializes simulator lanes (`sim-e2e.ts`).
- A spec's `test.use` of a worker-scoped option (`video`, `trace`,
  `screenshot`, launch options), even to its default, moves its tests into
  extra workers that each boot a browser, database and Worker harness. Only
  `workerdProfile` may split workers; do not add a worker option for one spec.
  Signed-out specs use the test-scoped `test.use({ signedIn: false })`. Gmail
  specs are named `gmail.*.spec.ts` so the one-worker `Gmail profile tests`
  project runs them together.
- Record video with `CUBBY_E2E_VIDEO=1`. `CUBBY_E2E_STARTUP_PROFILE=1` (always
  on in CI) annotates navigation with startup timings; these are diagnostics,
  never correctness results, and task CPU categories must not be summed.
- A standalone Playwright request context inherits project storage state unless
  it sets empty cookies and origins.

### Waiting for readiness

- Hydration waiting polls the authenticated shell's hydrated marker on
  animation frames. Keep that single DOM condition; do not nest an auto-waiting
  locator assertion inside `toPass`.
- Goal-driven journeys wait for the record's editor defaults and requested
  picker options before asking the decision model to act. For repeated
  targetless taps, open the known picker with SDK locators. Readiness waits do
  not replace stored-data read-back, and never treat a caught model error as
  success.
- Secondary record actions live in the header overflow. Navigate with
  `gotoDetailActions` using the action as its ready locator, or call
  `openDetailActions` first, including after returning to the same record.
  Never use a hidden secondary action as the hydration marker. Closed overflow
  owners stay mounted, so select the visible popover.
- Responsive table toolbars mount desktop and phone branches during SSR. Use a
  retrying `toHaveCount(1)` and `toBeEnabled()` before a strict search action;
  do not use `.first()` or a sleep.
- Disclosure bodies mount only after opening. Explanation journeys open
  Technical details before asserting rule identifiers. Lazy quality
  explanations wait for the row's loaded assessment; a new record with no
  publication reveals the empty Quality column.
- Between tooltips, scope to the target's tooltip and `[data-open]`; the
  previous one stays mounted while closing.
- Fast header pointer probes wait for the dnd-kit target announcement before
  release. RTable's placeholder transition can eat clicks, so cell-edit tests
  retry opening and filling as one action. After a column customizer removes
  its focused row, a retry must require the full order unchanged and stop once
  the expected order appears; never repeat a relative move.
- Native relation journeys wait for the destination detail marker; a
  successful tap is not navigation. Await card and ancestor animations before
  recording a geometry baseline. Scope CPU throttling to the guarded race.

### Locators

- Testing Library role queries match string names exactly by default; `exact`
  is a Playwright option.
- Use `chooseOption` for enum Pickers rendered as button comboboxes;
  `selectComboboxItem` fills a searchable entity Picker input.
- Choose a visible matching link, not the first DOM match: collapsed and
  responsive branches keep hidden duplicates. When a name appears on links to
  several entity kinds, combine it with the canonical href.
- Scope by the owning named region: recipe ingredients through the
  Ingredients region, relationship links through their section, sidebar
  assertions by the section's own heading. Relation-table links target the
  visible record href; shortcode metadata can be mounted but hidden. Assert the
  container is unique instead of using `first()`.
- A row filter's `has` locator is relative to that row. Shopping-list quantity
  assertions scope to the Ingredient row's Need cell.
- Name the dialog: date popovers also use the dialog role and can stay mounted
  while closing.
- Rows with interactive facts expose a title identifier; navigate by it, not
  the aggregate row, whose center can hit an explanation control. Use
  `openCellExplanation` when the explanation rail's host column is not known.
- Table record-identity links open an inspector. Follow Open full details or
  navigate directly for full-record assertions.
- Sort with the named Sort by button: a header click can open its menu. Open
  Filters before clearing predicates. Compare column order by `data-column-id`.
- Grouping journeys use the visible list Group control.
- Locate saved collection rows by value; a combined edit can reorder them.
- Dismiss a modal inspector before using the toolbar beneath it; never bypass
  focus containment with hidden-role queries or forced clicks. Compare related
  layout bounds in one browser evaluation.

### Requests and RPC results

- workerd drops an idle keep-alive socket after 5s while Playwright reuses it,
  so the fixtures retry an idempotent `page.request`/`request` call once on
  `ECONNRESET`. A POST or PATCH is never replayed.
- Browser diagnostics require decoded RPC success, not HTTP 200. Reuse
  `operationResult` in `apps/web/tests/e2e/support/dispatch-wire.ts`: single
  responses need `ok === true`; streamed NDJSON items need both settlement
  `r.ok` and operation `r.value.ok`. Decode the write's success (for example an
  `suggestion.reviewBatch` applied item) before storage read-back; events such
  as member Feedback persist before the application transaction commits.
- After a browser write, use `performOperation` from the same module when
  direct read-back needs the commit. Poll only genuinely eventual work.
- Browser dispatch can batch concurrent queries. A mock that parses one
  envelope uses `unbatchFor`; count operation attempts separately from
  transport fallback.
- Request-correlation fixtures use a valid `cf-ray` (hex, optional colo).
- Request interception disables Chromium's HTTP cache. Scope synthetic retailer
  documents to the retailer page, install interception just before the action
  that needs it and remove it before later navigations. When holding a
  response, release its gate and await `page.unrouteAll({ behavior: "wait" })`.
  Table-row fixtures for selection actions include TanStack's `row.id`.
- Image prerequisites upload synthetic bytes to the worker's object store;
  never fulfill app image URLs with page routes. Assert decoding as well as
  visibility. A spec may declare `objectStoragePublicUrl` for an HTTPS source
  identity; its transport must forward to the stored bytes.
- Retired-route status contracts use `request.get`; browser scenarios own
  visible not-found behavior.
- Follow a destination link the journey already exposes, and assert that
  `performance.timeOrigin` is unchanged for in-app transitions. Keep document
  loads only where they own direct-link, SSR or persistence regressions.
- Status assertions on bootstrap requests include the response body. Explicit
  screenshots are for visual comparison or demo output only.

### List URLs and filters

- Entity-list search uses the generated `searchQuery` key; build declared
  column filters with `entityListHref`. Other list URLs use the descriptor's
  declared `urlKey` (for example `q` on Expense and Purchase search). Obsolete
  aliases are dropped by route validation and leave an unfiltered list.
- Assert the active filter control and include unrelated records with a small
  page size; an ignored filter can pass on a small local corpus. Fuzzy search
  can include neighbors, so assert intended records, not exact totals.
- Infinite entity lists ignore `pageSize` in the URL. Unloaded-selection
  fixtures must cross the real default page boundary and hold the next page.
- Filter journeys verify rows and URL state after reload or history
  navigation. An open editor and an active chip can share a label.
- A create-dialog journey that knows its record name scopes the background
  list with `searchQuery` while opening `?create=true`.
- When changing shared list view controls, update interaction tests for every
  consumer, including USDA lists.

### E2E fixtures and derived work

- An isolated E2E login has no linked member LedgerParty. Call
  `ensureMemberParty(page, name)` from `tests/e2e/fixtures/core.ts` before a
  member-scoped surface such as Mail import.
- E2E `createFixture`, `createEntityFixture` and `createFixtureGraph` return
  only an identity; assertions still load real projections. Create searchable
  picker records through `createEntityFixture` so the SearchDocument exists,
  and wait for the picker's search response before selecting.
- Use `createEntityFixtures` for a same-kind cohort and `createFixtureGraph`
  for a mixed prerequisite graph: both commit once and settle projections
  once. Its callback's transaction database resolves shared brands with
  `resolveProductBrandName`. Keep fixtures with intermediate browser reads
  outside the graph, and run work that consumes the committed graph (recipe
  costing, proposal publication) after it. Independent journeys use separate
  graphs.
- After a browser write, call `drainDerivedRefreshFrontier(db)` before a direct
  serializable import such as `recordSourceTransactionRecords`; the offline
  search pump can otherwise fail it intermittently.
- Suggestion fixtures publish proposals after commit and drain their registered
  publication before asserting visibility. Never drain after a stale-support
  edit or member decision to hide an authority-gate failure.
- The offline browser pump accelerates deterministic rebuilds. A journey that
  asserts the interval before the next pass overrides `e2eDerivedRefresh` with
  a plain `provide()` fixture so the pump cannot repair what it asserts.
- Seed incidental prerequisites through fixtures, using the authenticated
  request context before any page load, instead of repeating unrelated create
  and search journeys.

### Reports and logs

CI artifacts and trace modes are in [CI](../ci.md#test-lanes). A failed E2E
test attaches the harness's scrubbed workerd logs (`harness.getLogs()`); the
local reporter keeps them in `playwright-report`. Each Playwright worker prints
`<origin>/cdn-cgi/local/explorer` at startup, so a paused (`PWDEBUG`, headed or
`--ui`) test can inspect Durable Object, queue, workflow and R2 state while the
worker lives. Local native runs keep their `sim-e2e` artifacts.

### Workerd test runtime and profiles

Vitest projects never start the built Worker; CI builds it only for browser
shards. The `workers` project runs source modules in workerd through the
Cloudflare pool. Agent and Worker journeys belong in Playwright; a PostgreSQL
rule behind them belongs in an integration test that injects bindings with
`setCfEnv`.

A runtime borrowing a `withTestDb` database closes in `afterEach`, before the
next reset; `afterAll` is too late and leaves unowned sessions that fail reset.
Tests that open independent database runtimes drain their server sessions
before reset: pool shutdown can finish before PostgreSQL removes the backend,
so identify them by tag or captured backend IDs and wait. Never terminate
unowned sessions to hide a cleanup failure. Reads that need a separate pool use
`createPostgresPool` from `tooling/postgres-pool.ts` and await `pool.end()` in
`finally`; it drains evicted sockets that a bare `Pool.end` can leave open.

A profile (`WORKERD_PROFILES` in `workerd-harness.ts`) routes each production
queue consumer to one of:

- `real`: the built Worker's own consumer, with production settings except
  `max_batch_timeout: 0`.
- `dropped`: `local-offline-peers` acknowledges and discards each message.

Choose the declared profile that exercises the real boundary. Durable Objects
are real in every profile, and the harness seeds the synthetic USDA release.
Starting a profile throws when its routes and the Worker's queue consumer names
differ; that check covers consumer names only, not producers or other
bindings. Scripted model and capture seams verify orchestration, not live
research quality or Gmail authorization.

The `Purchase import agent` project (`tests/e2e/purchase-import-run.spec.ts`,
`workerdProfile: "purchase-agent"`) drives the browser against a scripted model
and gateway; `e2eRuntime.purchaseAgent` loads each test's script. It runs in CI
as an optional job (`pnpm --dir apps/web test:e2e:ci:purchase-import`).

- Derive inference expectations from `importRunAgentManifest`. The gateway
  answers OpenAI and Anthropic tool streams; Mail settlement scenarios await
  the audit response before asserting terminal Run status.
- Hold the model with a `{ gate }` step to observe a live Run; scripts use
  `currentRunId` for a Run the browser starts. Prefer this project for
  anything a Run or Purchase page shows.
- Generate an item title once per fixture and reuse it (tests share a worker
  database). Completed Mail report fixtures assign their Emails to the Run.

## Test and dev data factories

One layer builds data for Vitest, E2E and the dev corpus:
`apps/web/tooling/factories/`. `buildEntity(entity, overrides, { faker })`
returns the parsed create input; `DOMAIN_DEFAULTS` supplies only the fields a
create needs beyond its schema defaults. `createEntity(context, ...)` writes it
through the entity kernel. A factory never defaults a relation id. E2E specs
call `createEntityFixture` and keep domain seeders in `tests/e2e/fixtures/*.ts`.
`seedBaseWorld` seeds Home and the taxonomy roots for every lane.

Faker fills only fields nothing asserts on, from a per-test seed (E2E title
path, `testFaker()` in Vitest, seed 1 for dev). A name a locator or assertion
uses is an override shaped `${label} ${deterministicToken(...)}` (`uniqueName`
in E2E). Shortcodes come from `@cubby/shared`, UPCs are valid literals, and
retailer corpora, statement CSVs, costing, nutrition and scenario states stay
literal. E2E records a `faker-seed` annotation; `testFaker()` prints its seed
on failure. `build:cf` fails if Faker reaches the Worker bundle.

Repository fixtures:

- Construct domain fixtures through the `createRepoEntity` writer roster, or
  the owning `create…Fixture` and `make…Input` helpers, so required defaults
  survive. Setup that consumes only IDs uses `createRepoIdentity` or
  `createProductIdentityFixture`.
- Do not substitute `insertWithShortcode`: it skips writer defaults and
  reference resolution. Create a valid record first and update storage only for
  a historical or invalid state the writer cannot express.
- Create Runs with `ensureRun` and an actor. For member-scoped purposes, link a
  member LedgerParty's `userId` first. Seed paused or failed states by updating
  the created row; build progress with its owning schema. System scheduling
  tests seed `systemActor().userId`.
- Evidence-revision and withdrawal fixtures set an explicit initial
  `observedAt`; a wall-clock default mixed with fixed revision dates eventually
  inverts the chronology.
- Equivalence fixtures assert that the changed input actually applies before
  comparing outputs, so a broad scope cannot hide a missing predicate.
- Plan and filter-oracle probes use production core reads; query-scope probes
  inspect complete SQL templates, not truncated telemetry.

Keep kernel fixtures declaration-backed. Table-derived insert schemas omit
virtual inputs and declaration defaults, and `drizzle-seed` writes directly to
tables; neither replaces `buildEntity`/`createEntity`.

### Migration rehearsals

Use `withMigrationDatabase` (`apps/web/tooling/test-database-lease.ts`) for
migration regressions. It owns an empty IntegreSQL lease, connection setup and
cleanup; the current-schema Vitest template cannot test a predecessor. Apply
boundaries with `migrateDatabase` from `tooling/db-migrate.ts` and exact
`through` folder names under `apps/web/drizzle/`. Keep predecessor-schema
fixtures and preservation assertions in the test; credentials, database names
and CREATE/DROP lifecycle belong to the lease.

Rehearse from the deployed prefix through the canonical migration. Delete a
rehearsal once production has applied its migration and the schema read-back
is verified; domain write and read-back tests then hold its invariants.
