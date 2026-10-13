# Test tiers and runtime traps

Prefer E2E for complete behavior through the built browser application or the
native client. Keep a focused unit, UI, PostgreSQL, or Workers test when it
catches a concrete failure the available E2E suites do not reasonably observe.
Before changing isolated behavior, record its failure modes and run a failing
regression test before editing the implementation, including declarations, SQL
bindings, and compiler guards. A delegated lane returns the pre-change failing
command and relevant output; tests added after implementation do not satisfy
this requirement. For `.tsx` changes, choose browser E2E when it observes
the behavior; use the UI or preview tier for distinct rendering or layout
failures. Keep pure logic imported by node tests in alias-free `.ts` files.
Temporary subprocess workspaces declare their module type explicitly, matching
the real consumer; do not rely on the local Node version's module detection.

Detail renderer and browser tests assert the continuous page: every section is
accessible without a view switch. Select a section hash to verify scrolling,
focus and history; empty sections retain headings, index entries and actions. After changing
any test fixture or query, use the web `typecheck` command: `typecheck:app`
excludes all test files, including browser previews, and cannot verify them.
Testing Library role queries use exact string names by default; Playwright's
`exact` option is not a Testing Library option.
When removing shared UI bindings, render every affected header branch or run
the app TypeScript check before handoff. Helper-only tests and lint do not
establish that a list or detail header can render with its actual props.

Do not overlap PostgreSQL and E2E locally: they contend for
containers, workerd, browsers, and database connections. For changed workspace packages, run their affected test rather than every
package. A cross-package contract change may need its consumers too.
Verify every named test path exists before invoking a runner: Vitest can ignore
a nonexistent selector when another supplied file matches. Report only the
files and cases the run actually exercised.
Keep database regressions scoped to the failure: one sort/page-boundary case can
establish stable order without enumerating every field and direction. Do not
append query matrices to image or ownership cases with a default test deadline.
For a named-case handoff, copy the exact replay selector or confirm the literal
test title with `rg` before invoking the runner. A title inferred from the task
description can select no cases; that setup failure supplies no regression evidence.

CI retries a failed Vitest or Playwright test once; locally nothing retries.
A test that passes only on retry is reported as flaky, not failed. The second
time a test is reported flaky, fix it or delete it, recording the named
failure and the deleting commit in a `docs/todos.md` entry so it can be
restored once fixed. Do not skip it in place: the test-run contract fails a
lane that reports skipped or pending tests. Never raise the retry count.

Scope artificial CPU throttling to the interaction whose race it guards;
restore normal speed for unrelated setup and read-back. A shared detail
renderer's section matrix renders once per entity and checks all declared
sections together; the continuous-detail browser journey owns hash navigation.

Before a focused browser replay, run `pnpm --filter @cubby/web run build:cf
--ensure` after changing the recorded source revision. The prebuilt provenance
gate can reject a run after workflow or documentation edits too; a
`source-changed` startup failure executed no scenarios and is not a test result.

Secondary record actions live in the contextual header overflow. Use `openDetailActions` after navigation, or `gotoDetailActions` when that panel is the next interaction; never use a hidden secondary action as the page hydration marker. Closed overflow owners stay mounted, so explanation checks select the visible popover rather than every popup node.

Target a browser spec as `pnpm test:e2e <spec>` without an extra `--`. E2E
serves `dist/`, so build it before a standalone run; `verify:local` does. The
coupled Workers harness rebuilds a stale web Worker itself. A
standalone Playwright request context inherits project storage state unless it
sets empty cookies and origins. workerd drops an idle keep-alive socket after 5s
while Playwright reuses it, so the E2E fixtures retry an idempotent
`page.request`/`request` call once on `ECONNRESET` ("socket hang up"); a POST
or PATCH is never replayed.

Hydration waiting uses one native `Locator.waitFor` for the authenticated
shell's attached hydrated marker. Do not nest an auto-waiting locator assertion
inside `toPass` for this single DOM condition. Session and sign-in diagnostics
run only after timeout and distinguish an unauthenticated SSR shell from a
client bundle that never hydrated.

Request-correlation browser fixtures use a valid Cloudflare ray (hex with an
optional data-center suffix): the server rejects arbitrary `cf-ray` strings.
Browser dispatch can batch concurrent queries. A mock that parses a single
operation envelope uses `unbatchFor` before its per-operation handler. Keep
lazy-fetch assertions sensitive to every envelope; after refusing a batch,
count individual operation attempts separately from transport fallback.
Compare related layout bounds in one browser evaluation so their rectangles
come from the same render state.

Playwright E2E and the coupled Workers harness share a per-worktree lock at
`/tmp/cubby-harness-<worktree hash>.lock` (`scripts/lib/harness-lock.ts`,
managed by `proper-lockfile`). It keeps one checkout's suites from rebuilding
its Worker under each other or starving each other of CPU; other worktrees run
concurrently on the shared test services. The library refreshes the lock
while held and reclaims it after an interrupted process. Child processes inherit
the owner marker and pass through. `test:e2e:watch` (`--ui`) skips the lock, since
its idle session would otherwise hold it indefinitely. Only the profiles marked
"yes" below take it; a Playwright run and the `integration-workerd` project hold
it from global setup, and their workers pass through. The only machine-wide
lock, `/tmp/cubby-native-device.lock`, serializes simulator lanes
(`sim-e2e.ts`); the Mac import lane keeps its own fixture lease.

A spec's `test.use` of a
worker-scoped option (`video`, `trace`, `screenshot`, browser launch options),
even to its default, moves its tests into extra workers that each boot another
browser, database, and Worker harness; only `workerdProfile` may split
workers (`tooling/e2e-worker-pool.unit.test.ts`). Each split costs a shard a
worker restart, so a signed-out spec uses the test-scoped
`test.use({ signedIn: false })`, and Gmail specs are named `gmail.*.spec.ts`
so the one-worker `Gmail profile tests` project runs them together at the start
of a shard. Record video for a
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
the Cubby application page. Install transient interception immediately before
the action that needs it, including opening UI that fetches automatically.
Remove it once its regression has been observed,
before later navigations or reloads. Image prerequisites upload synthetic bytes
to the isolated worker object store; do not fulfill application image URLs with
page routes. Assert image decoding as well as visibility. Retired-route HTTP status
contracts use `request.get`; browser scenarios own visible not-found behavior.
When a journey already exposes the destination link, follow that link to exercise
client navigation. When a record name occurs on links to multiple entity kinds,
combine its accessible name with the canonical href before choosing a link.
Keep document loads and reloads that own direct-link, SSR, or
persistence regressions. Use the existing authenticated request context for fixture setup before any
page load. A synthetic socket-only browser peer can use the same-origin session
response as its document; its separate capture page still exercises the real
external DOM. A link transition expected to stay within the app can
assert that `performance.timeOrigin` is unchanged, so a plain anchor cannot
silently turn it into another document load. When comparing card geometry across
enrichment, await the card and ancestor animations after switching list views
before recording the baseline; a visible loading field can precede the settled
view gutter. Preserve the exact before/after size assertions. After a column
customizer action removes its focused row, dialog focus restoration can consume
the next keyboard activation. An action retry must require the complete order
to remain unchanged and stop once the exact expected order is visible; never
repeat a relative move after it has applied or weaken the ordering assertion.

### Workerd test runtime and profiles

A PostgreSQL test file that starts workerd belongs in
`workerdIntegrationTests` (`apps/web/vitest.config.ts`), which forms the
`integration-workerd` project; CI runs it in the Worker build job against
that job's fresh bundle. An unlisted consumer fails in the ordinary integration
job.

Native relation journeys scroll the navigation row back into view after inspecting
its badges, then wait for the destination detail marker before inspecting
inverse evidence. A successful tap alone does not establish navigation.
Rows with interactive facts expose a separate title identifier; navigation
tests target that title rather than the aggregate row, whose center can land
on a field explanation control.

A profile (`WORKERD_PROFILES` in `workerd-harness.ts`) routes each production
queue consumer to one of:

- `real`: the built Worker's own consumer, with production settings except
  `max_batch_timeout: 0`.
- `dropped`: `local-offline-peers` acknowledges and discards each message.
- `unconsumed`: no consumer; messages stay queued.

| Profile          | Used by                                   | `cubby-background` | `cubby-telemetry` | `cubby-purchase-agent` | Extra peers                    | Harness lock |
| ---------------- | ----------------------------------------- | ------------------ | ----------------- | ---------------------- | ------------------------------ | ------------ |
| `offline`        | browser default, simulator, Tester Army   | dropped            | dropped           | unconsumed             | none                           | no           |
| `gmail`          | `gmail.*.spec.ts` browser specs           | real               | dropped           | unconsumed             | local Google provider          | no           |
| `native-import`  | Mac import lane                           | dropped            | dropped           | real                   | queue producer, model, gateway | yes          |
| `purchase-agent` | agent scenarios, live evals, browser spec | unconsumed         | real              | real                   | queue producer, model, gateway | yes          |
| `coupled`        | coupled Tester Army journeys              | real               | real              | real                   | queue producer, model, gateway | yes          |

Every profile includes `local-offline-peers` as the sink for dropped queues.
Durable Objects live in the built Worker and are real in every profile; the
harness seeds the synthetic USDA release into `USDA_RELEASES` before any USDA read. Starting a
profile throws when its routes and the compiled Worker's queue consumer names
differ in either direction. That check covers consumer queue names only, not
producers, Durable Objects, Hyperdrive, or service bindings, so it is not
exhaustive binding coverage; `tooling/workerd-runtime-profiles.integration.test.ts`
probes each profile's queues in a running harness.

A browser spec may declare `objectStoragePublicUrl` for an HTTPS source identity
while its bucket remains local. Its asset transport must forward requests to the
actual stored bytes; do not substitute an image or loosen capture URL guards.
The visible purchase-research journey uses that seam for retained catalog-image
reuse, real queue delivery, automatic child research, and UI provenance. Its
model decisions and Mac captures are scripted; it does not evaluate live research
quality, remote retailer image downloads, or Gmail discovery.

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
Branch on the current public tool-result shape (`imports_read.mail` returns
the retained Email's `content` and `checksum`; `purchase_import.commit` and
`mail.resolve` settle it). Generate an item title once per fixture and reuse
it in the retained original and proposal: tests share a worker database, so
unrelated fixtures must not collide on Product name/manufacturer. Repeated
orders for the same item reuse the Product reference returned by resolution.

CI's web E2E artifact is Playwright's built-in HTML report and retained traces.
Each Playwright job uploads them under an artifact name containing the tested
commit SHA. CI traces only the retry of a failed test (`on-first-retry`);
local runs keep failure traces (`retain-on-failure`). Open
`playwright-report/index.html` from the downloaded artifact to inspect the
run. Local native runs keep the `sim-e2e` artifacts, which record their build,
process, simulator, watchdog, scenario and replay evidence. These established
artifacts remain useful diagnostics; a custom run bundle is not required for
every E2E journey or runtime acquisition.

A failed E2E test attaches the Worker harness's structured workerd logs
(`harness.getLogs()`, credential-shaped values scrubbed) to the Playwright
result, where the HTML report can open the attachment. The local reporter also
keeps its workerd logs in `playwright-report`. Each Playwright worker prints
`<origin>/cdn-cgi/local/explorer` at startup, so a paused (`PWDEBUG`, headed, or
`--ui`) test can be inspected for Durable Object, queue, workflow, and R2 state.
The URL is only valid while that worker is alive.

List URLs in browser fixtures use the filter descriptor's declared `urlKey`
(for example, `q` for Expense and Purchase search). Assert the active filter
control and include unrelated records with a small page size when testing a
filtered record; an ignored filter can pass against a small local corpus and
hide the target behind pagination in CI.

When changing shared list view controls, update interaction tests for every
consumer, including USDA lists. Preserve their query and destination regressions
when replacing the control's selectors.

Lazy quality-explanation journeys wait for the row's loaded assessment before
opening it; initial trigger visibility can precede deferred enrichment. When
hovering consecutive timestamp cells, assert the open tooltip so the previous
tooltip's closing animation cannot create a duplicate text match.

## Preview tests (real-browser layout invariants)

The `preview` Vitest project (`**/*.preview.test.tsx`, `pnpm --dir apps/web
test:preview`) renders components in a real headless Chromium tab via
Playwright, at the widths the app actually ships — a phone (402x874) and a
desktop (1440x900) — and asserts layout facts jsdom cannot see: bounding-box
sizes, whether a rerender changed an element's height (a layout-shift
regression), and which `min-width`/media-query breakpoint actually applies.
Use the `ui` (jsdom) tier for a distinct event, accessibility or conditional
rendering failure that the retained journey cannot reasonably expose. Keep
copy-only and DOM-structure assertions out of both tiers. Reach for `preview`
only when the behavior under test IS the
layout (a fixed-footprint glyph across states, an inline review folding
instead of growing the page, a headline that must not wrap). It is opt-in
(not part of `pnpm test`) because a real browser launch is slower than the
shared jsdom graph; select it with `--project=preview`, `--project preview`,
`test:preview`, or a direct `.preview.test.tsx` file argument. It is not
wired into CI yet — doing so would need a Playwright browser install step in
the combined `Auxiliary tests and builds` lane, which every web change would pay for; wire it into that
existing workflow once more than one component family needs it. Preview specs
need Tailwind's real
CSS output (`tooling/preview-test-setup.ts` imports `~/styles.css`) since a
utility class only affects a real browser's layout once Tailwind has
generated it — jsdom tests never needed this because jsdom has no layout
engine to feed.

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

Keep kernel fixtures declaration-backed. The
[Drizzle v1 RC spike](../research/drizzle-v1-spike.md) confirmed that
table-derived insert schemas omit virtual inputs and declaration-level defaults;
`drizzle-seed` generates foreign keys and writes directly to tables. Those are
storage-fixture capabilities, not replacements for `buildEntity`/`createEntity`.

Migration regressions rehearse the committed journal from the actual deployed
prefix through the canonical migration using a leased local database and
`migrateDatabase`. Delete a migration's rehearsal once production has applied
it and its schema readback is verified; the invariants it guarded are then
held by domain write/readback tests (for example, source-claim-family tests own
invalid alias-family refusal, and fact-evidence-subject tests own canonical
Product/Purchase proof and idempotent preservation).

Provider discovery scenarios grant historical backfill and continuous new-mail
catchup independently. A backfill continuation never authorizes a history pass;
assert that each continuation retains its own execution authorization.
