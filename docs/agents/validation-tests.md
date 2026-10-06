# Test tiers and runtime traps

Prefer E2E for complete behavior through the built browser application or the
native client. Keep a focused unit, UI, PostgreSQL, or Workers test when it
catches a concrete failure the available E2E suites do not reasonably observe.
Before adding an isolated test, record its failure modes and write the failing
test before the code. For `.tsx` changes, choose browser E2E when it observes
the behavior; use the UI or preview tier for distinct rendering or layout
failures. Keep pure logic imported by node tests in alias-free `.ts` files.

`pnpm test` runs fast unit, UI, contract, and auxiliary tests; `pnpm
test:postgres` runs the `integration` and `integration-workerd` contract
projects; `pnpm test:e2e` runs PostgreSQL-backed
browser tests; `pnpm test:all` runs fast, PostgreSQL, then Playwright
sequentially. Do not overlap PostgreSQL and E2E locally: they contend for
containers, workerd, browsers, and database connections. Other workspace
packages need `pnpm -r --filter '!@cubby/web' run test` after changing
`packages/*`.

Target a browser spec as `pnpm test:e2e <spec>` without an extra `--`. E2E
serves `dist/`, so build it before a standalone run; `verify:local` does. The
coupled Workers harness rebuilds a stale web Worker itself. A
standalone Playwright request context inherits project storage state unless it
sets empty cookies and origins. workerd drops an idle keep-alive socket after 5s
while Playwright reuses it, so the E2E fixtures retry an idempotent
`page.request`/`request` call once on `ECONNRESET` ("socket hang up"); a POST
or PATCH is never replayed.

Playwright E2E and the coupled Workers harness share a machine-wide lock
(`/tmp/cubby-harness.lock`, `scripts/lib/harness-lock.ts`): a second suite on
the same machine queues and logs who holds the lock instead of starving both
of CPU. A lock whose owner process exited is reclaimed. Processes the holder
spawns pass straight through. Lock regression tests measure the held interval
up to immediately before unlock; output after unlock is outside that interval. `test:e2e:watch` (`--ui`) skips the lock, since
its idle session would otherwise hold it indefinitely. A spec's `test.use` of a
worker-scoped option (`video`, `trace`, `screenshot`, browser launch options),
even to its default, moves its tests into extra workers that each boot another
browser, database, and Worker harness; only `workerdProfile` may split
workers (`tooling/e2e-worker-pool.unit.test.ts`). Record video for a
run with `CUBBY_E2E_VIDEO=1`. RTable's placeholder transition can eat clicks;
cell-edit tests retry opening and filling as one action.

Responsive table toolbars mount both desktop and phone branches during SSR.
After navigation, use a retrying `toHaveCount(1)` assertion on the role locator
and `toBeEnabled()` before a strict search action. Playwright resolves strict
locators before waiting for hydration-disabled controls to become enabled;
the assertion preserves uniqueness while the responsive branches settle.
Do not select `.first()` or add a sleep to bypass duplicate controls.

Playwright request interception disables Chromium's HTTP cache. Scope synthetic
retailer documents to the retailer page, never the shared browser context or
the Cubby application page. Remove transient failure interception before later
reloads once its regression has been observed. Retired-route HTTP status
contracts use `request.get`; browser scenarios own visible not-found behavior.

### Workerd test runtime and profiles

A PostgreSQL test file that starts workerd belongs in
`workerdIntegrationTests` (`apps/web/vitest.config.ts`), which forms the
`integration-workerd` project; CI runs only that project against the
`worker-build` artifact, and an unlisted consumer fails in an ordinary shard.
The socket-lifecycle regression lives in that workerd integration project: it
exercises HTTP reads and freshness writes against the real Worker and observes
PostgreSQL socket expiry, without a browser. Preserve its twelve-second quiet
windows and repeated-load assertions when changing its scheduling.

Browser workers, Tester Army, native runners, the purchase-agent Vitest scenarios and the
live evals start the built Worker through `openWorkerdRuntime`
(`apps/web/tooling/workerd-runtime.ts`); a caller that runs work after
startup uses `withWorkerdRuntime`, which closes the runtime even when that
work throws. The runtime acquires the database (a lease it releases, or a
borrowed database it never closes), owned or borrowed object storage,
the profile's peers, and the harness. `close()` releases them newest first
and runs every release even when one fails; a start that fails at any step
releases everything acquired before it. Borrowed storage carries its S3
endpoint and public URL separately; neither startup failure nor close stops
caller-owned storage. Native runners keep their build, process, simulator,
watchdog, scenario and artifact boundaries outside the runtime. Their
`leaseNamedDatabase` backend in `test-database-lease.ts` creates and migrates
only `cubby_sim_<16 hex>` names on the guarded loopback admin server at port 55432. Normal close verifies the database was dropped; `retention: "retain"`
explicitly leaves it available for debugging. Failed acquisition always drops
the database it created, including in retain mode; a name collision never
gives ownership of an existing database. The lease's `onCreated` hook runs
right after CREATE succeeds and before migration. The Mac import runner and
every `sim-e2e.ts` run start their detached database watchdog there, so a
runner killed at any point after CREATE, including mid-migration, still has
its database dropped; only the simulator watch lane (`sim-dev`) also has the
watchdog close its agent-device session. Native scenario seeding stays in the
runner's lease `setup` callback, which runs after migration. Both callbacks
receive only the name and URL, never the lease's `close`. The lease
regressions (`named-database-lease.integration.test.ts`) need the guarded
55432 endpoint: CI publishes it from `start-test-services`, and locally the
suite runs `scripts/dev-db.ts up` unless `CUBBY_SIM_DB_EXTERNAL=1`. A watchdog
regression that holds a migration-blocking connection destroys that connection
on release before waiting for the forced DROP; returning it to the idle pool
races cleanup and emits an unhandled PostgreSQL `57P01` error. IntegreSQL
namespaces and reset policies stay unchanged.

A profile (`WORKERD_PROFILES` in `workerd-harness.ts`) routes each production
queue consumer to one of:

- `real`: the built Worker's own consumer, with production settings except
  `max_batch_timeout: 0`.
- `dropped`: `local-offline-peers` acknowledges and discards each message.
- `unconsumed`: no consumer; messages stay queued.
- `native-continuation`: the Mac continuation peer records native Sync
  retries.

| Profile          | Used by                                   | `cubby-background` | `cubby-telemetry` | `cubby-purchase-agent` | Extra peers                    | Harness lock |
| ---------------- | ----------------------------------------- | ------------------ | ----------------- | ---------------------- | ------------------------------ | ------------ |
| `offline`        | browser default, simulator, Tester Army   | dropped            | dropped           | unconsumed             | none                           | no           |
| `gmail`          | `test.use({ workerdProfile: "gmail" })`   | real               | dropped           | unconsumed             | local Google provider          | no           |
| `native-import`  | Mac import lane                           | dropped            | dropped           | native-continuation    | continuation peer              | no           |
| `purchase-agent` | agent scenarios, live evals, browser spec | unconsumed         | real              | real                   | queue producer, model, gateway | yes          |
| `coupled`        | coupled Tester Army journeys              | real               | real              | real                   | queue producer, model, gateway | yes          |

Every profile includes `local-offline-peers` for the USDA binding. Durable
Objects live in the built Worker and are real in every profile. Starting a
profile throws when its routes and the compiled Worker's queue consumer names
differ in either direction. That check covers consumer queue names only, not
producers, Durable Objects, Hyperdrive, or service bindings, so it is not
exhaustive binding coverage; `tooling/workerd-runtime.integration.test.ts`
probes each profile's queues in a running harness.

The harness lock is the one machine-wide lock above; only the profiles marked
"yes" take it (and rebuild a stale Worker). A Playwright run already holds it
from global setup and its workers pass through; other `offline`, `gmail`,
and `native-import` callers run without it. Run one runtime per process at a time: it
snapshots and restores `E2E_DATABASE_URL` and the Hyperdrive variables
process-wide, and the lock is reentrant within a process, so two concurrent
runtimes would restore each other's environment.

The `Purchase import agent` Playwright project
(`tests/e2e/purchase-import-run.spec.ts`,
`test.use({ workerdProfile: "purchase-agent" })`)
runs the browser against the purchase-agent workerd harness with a scripted
model and gateway; `e2eRuntime.purchaseAgent` loads each test's script. It is
excluded from the required desktop shards and runs in CI as an optional job
(`pnpm --dir apps/web test:e2e:ci:purchase-import`). Hold the model with a
`{ gate }` step to observe a live Run instead of racing it; a Run the browser
starts has no id until the click, so scripts use `currentRunId`. Prefer it over
a UI-less scenario for anything the Run or Purchase page shows; keep scenarios
for server fences the UI cannot observe.

Every completed E2E run produces a sanitized run bundle with its revision,
replay command, runtime versions, case results, and SHA-256 checksums. CI uploads
successful and failed bundles for seven days. A dirty local checkout or a build
that cannot be tied to its source revision is marked as not exactly replayable.
Raw HTML reports, traces, screenshots, and database dumps stay local because
they can contain household data or credentials. Run `shasum -a 256 -c
SHA256SUMS` from the downloaded bundle directory to verify its contents, then
replay the `command` array in `run-manifest.json` against the recorded commit.

A failed E2E test attaches the Worker harness's structured workerd logs
(`harness.getLogs()`, credential-shaped values scrubbed) to the Playwright
result and copies them into the bundle under `workerd-logs/`; the case entry in
`run-results.json` records the harness explorer URL. Each Playwright worker also
prints `<origin>/cdn-cgi/local/explorer` at startup, so a paused (`PWDEBUG`,
headed, or `--ui`) test can be inspected for Durable Object, queue, workflow,
and R2 state. The URL is only valid while that worker is alive.

Run `pnpm wasm` after WASM changes. The shared `CARGO_TARGET_DIR` can be
written by another checkout, so confirm generated output is current. Generated
API changes require the owning generated-surface workflow and affected native
checks.

Mapped database fixtures annotate the callback return with the table
`$inferInsert` type so enum literals retain their insert contract; passing a
runtime test does not verify TypeScript inference.

Pricing integration tests stub the catalog socket for every test and keep it
separate from inference socket overrides. The runtime catalog client reads
`fetch` when requesting; a hoisted stub alone stops protecting later tests once
`unstubAllGlobals` runs. Integration files share a module graph, so reset it
before installing a file-specific catalog and never let cached live rates leak
into synthetic accounting assertions.

## Affected-only E2E for local iteration

`pnpm --dir apps/web test:e2e:affected` first ensures the fingerprint-checked
web build is current, then runs Playwright's `--only-changed=origin/main`. Playwright selects
changed spec files and specs that import changed files; append `--list` to
preview that selection. This is a local heuristic, not a merge gate: browser
routes and components need not be imported by a spec, so an app-only change
can select nothing. Name the affected spec explicitly or run the full
`test:e2e` for those changes. CI keeps running the full suite. Set
`CUBBY_TEST_SERVICES=warm` to reuse local macOS services, as with direct
Playwright runs.

## Preview tests (real-browser layout invariants)

The `preview` Vitest project (`**/*.preview.test.tsx`, `pnpm --dir apps/web
test:preview`) renders components in a real headless Chromium tab via
Playwright, at the widths the app actually ships — a phone (402x874) and a
desktop (1440x900) — and asserts layout facts jsdom cannot see: bounding-box
sizes, whether a rerender changed an element's height (a layout-shift
regression), and which `min-width`/media-query breakpoint actually applies.
The `ui` (jsdom) tier is right for everything else a rendered component needs
— events, text content, ARIA roles, conditional rendering — since it starts
far faster; reach for `preview` only when the behavior under test IS the
layout (a fixed-footprint glyph across states, an inline review folding
instead of growing the page, a headline that must not wrap). It is opt-in
(not part of `pnpm test`) because a real browser launch is slower than the
shared jsdom graph; select it with `--project=preview`, `--project preview`,
`test:preview`, or a direct `.preview.test.tsx` file argument. It is not
wired into CI yet — doing so would need a Playwright browser install step in
the `Tests - web (ui)` lane, which every push would pay for; wire it into that
existing workflow once more than one component family needs it. Preview specs
need Tailwind's real
CSS output (`tooling/preview-test-setup.ts` imports `~/styles.css`) since a
utility class only affects a real browser's layout once Tailwind has
generated it — jsdom tests never needed this because jsdom has no layout
engine to feed. A component that imports `@cubby/recipebridge` (directly or
transitively) needs `pnpm wasm` run first, same as the `ui` tier.

## Test and dev data factories

One layer builds data for Vitest, E2E, and the dev corpus:
`apps/web/tooling/factories/`. `buildEntity(entity, overrides, { faker })`
returns the entity's parsed create input (the entity list and types come from
the generated create schemas; `ENTITY_DEFAULTS` is exhaustive, so a new creatable
entity cannot skip it). `createEntity(context, ...)` writes it through the
entity kernel. A factory never defaults a relation id; pass it. E2E specs call
`createEntityFixture(page, entity, overrides)` from `tests/e2e/fixtures-core.ts`
and keep domain seeders in `tests/e2e/fixtures-*.ts`. `seedBaseWorld` seeds Home
and the taxonomy roots for every lane.

Faker fills only fields nothing asserts on, from a per-test seed (E2E title
path, Vitest test name via `testFaker()`, dev seed 1). A name a locator or
assertion uses is an override shaped `${label} ${deterministicToken(...)}`
(`uniqueName` in E2E); shortcodes come from `@cubby/shared` and UPCs are valid
literals, never Faker. E2E records the seed as a `faker-seed` annotation, and
`testFaker()` prints it when the test fails. Retailer corpora, statement CSVs,
costing and nutrition numbers, and scenario states stay literal. `build:cf`
fails if Faker reaches the Worker bundle.
