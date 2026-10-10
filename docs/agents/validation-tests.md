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

`pnpm test` runs fast unit, UI, contract, and auxiliary tests; `pnpm
test:postgres` runs the `integration` and `integration-workerd` contract
projects; `pnpm test:e2e` runs PostgreSQL-backed
browser tests; `pnpm test:all` runs fast, PostgreSQL, then Playwright
sequentially. Do not overlap PostgreSQL and E2E locally: they contend for
containers, workerd, browsers, and database connections. Other workspace
packages need `pnpm -r --filter '!@cubby/web' run test` after changing
`packages/*`.
Verify every named test path exists before invoking a runner: Vitest can ignore
a nonexistent selector when another supplied file matches. Report only the
files and cases the run actually exercised.
For a named-case handoff, copy the exact replay selector or confirm the literal
test title with `rg` before invoking the runner. A title inferred from the task
description can select no cases; that setup failure supplies no regression evidence.

CI retries a failed Vitest or Playwright test once; locally nothing retries.
A test that passes only on retry is reported as flaky, not failed. The second
time a test is reported flaky, fix it or delete it, recording the named
failure and the deleting commit in a `docs/todos.md` entry so it can be
restored once fixed. Do not skip it in place: the test-run contract fails a
lane that reports skipped or pending tests. Never raise the retry count.

Plant Durable Object recovery state before the first RPC schedules an automatic
alarm. Mutating attempt counters after a status read races real work and can
turn the recovery regression into a successful load. In popover journeys,
close the popover through its supported keyboard action and assert that the
parent dialog remains open; do not click obscured instructional text.

Scripted multi-task decisions must use the task returned by Next or its declared
stable ordering. Ordering fixture rows by a different column can apply a judgment
to another task even when the issued references are valid. Inspect the task
context and attempted resolution together before diagnosing a write failure.

Before replaying a fixture correction, inspect the exact changed helper, the
called API's output schema, external port signatures and the complete proposed
operand's shared schema.
Validate that operand before starting SQL or Worker infrastructure. Resolve work
through the declared output or a durable ownership relation; do not assume an
admission call returns a Run reference.
Check evaluation budget overrides against the harness's declared limits before
starting containers or inference. Rejected configuration executes no scenarios
and supplies neither regression nor real-model acceptance evidence.
When parsing an opaque tool reply with a partial Zod object, declare every field
the regression later inspects: undeclared fields are stripped, so parsing only
`status` can erase issued work and manufacture a missing-task failure. A fixture
expecting a validation correction must contain a real discrepancy between the
recorded values and the retained source; matching values do not require review.
Before fixture writes and table assertions, inspect the declared row shape,
ownership graph, and lifecycle transition. Use the real transition when the
test is about its effect; otherwise use its actual status/failure-code pair,
validated by the shared schema and database constraint. A user-facing label
such as cancellation need not be a stored status. An admission's member
reference does not imply a direct member column; assert the declared relation
or attribution graph. Object matchers accept nonexistent expected keys at
compile time. A constraint failure in fixture setup is not the intended RED.
Run fixtures carry complete required actor attribution and trigger; copy those
from an owned admitted scope, including its member shortcode, rather than
inventing a minimally attributed row. A dispatch-failed Run uses the public
`abort` action; `cancel` applies only to active Runs.
Repository create fixtures retain the public shortcode in `id` and attach the
branded database UUID as `entityId`. Use `entityId` for internal admissions,
repository mutations and row predicates; use `id` for public operation inputs.
Direct Drizzle fixtures need the table's branded UUID type too. Parse a generated
UUID at fixture creation; a plain `crypto.randomUUID()` is not a branded Run ID.
Create Products with `createProductFixture(db, makeProductInput({...}), actor)`;
use its `entityId` internally and `id` in public calls. Do not construct a
minimal Product with `insertWithShortcode`: database fields such as
manufacturer have required values supplied by the input factory, and domain
effects belong to the repository create path. Inspect the factory before
adding a Product fixture, including in a harness-profile test.
Derive source checksums from distinct synthetic content. Reusing a convenient
constant can collide with a protected source association and exercise evidence
preservation instead of the intended disposable-evidence failure. Inspect those
associations before asserting that a checksum is disposable.
Pre-admitted real-model cases that share a seller domain reuse one canonical
Vendor, with independent order identities and retained mail. Check this before
inference: duplicate fixture Vendors turn a supported SKU into a genuine issuer
refusal and measure fixture corruption instead of research behavior. Keep the
production ambiguity guard intact.
Browser fixtures for independent synthetic retailers use their own Product-page
hosts. Adding a shared real retailer domain to each fixture Vendor creates
competing canonical issuers across the suite; an isolated replay can miss that
collision. Use a shared canonical Vendor only when that retailer is the subject
of the regression.
Exact-identifier fixtures use the canonical issuer resolver and source
registration. A familiar retailer name or a Vendor-shaped source slug does not
establish domain authority or identifier ownership.
Before a focused browser replay, run `pnpm --filter @cubby/web run build:cf
--ensure` after changing the recorded source revision. The prebuilt provenance
gate can reject a run after workflow or documentation edits too; a
`source-changed` startup failure executed no scenarios and is not a test result.

A shared-worktree Worker build starts after every source writer explicitly
acknowledges a stable revision. Hold all repository source, test, documentation,
and generated-file edits until the runner reports terminal completion. Send
its live handle to every writer and release the hold after cleanup. A test-only
edit also changes the build fingerprint; a rejected build supplies no scenario
evidence.
Workerd suites acquire the machine-wide harness lock in `beforeAll` using
`HOLD_WORKERD_HARNESS_TIMEOUT_MS`, then release it in `afterAll`. Queue waits
belong to setup and must not consume a scenario's behavioral timeout.
Use the shared E2E identity and bundle for source provenance. Do not add a
second recorder that buffers the entire Git diff: a large breaking change can
overflow the subprocess buffer before the scenario and its cleanup begin, and
the diff omits untracked replacement files. Fixture-specific hashes may remain
in the scenario report.

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

Playwright E2E and the coupled Workers harness share a machine-wide lock at
`/tmp/cubby-harness.lock`, managed by `proper-lockfile`. It prevents concurrent
suites on one machine from starving both of CPU; the library refreshes the lock
while held and reclaims it after an interrupted process. Child processes inherit
the owner marker and pass through. `test:e2e:watch` (`--ui`) skips the lock, since
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

Keep the complete browser regression suite on PRs. Consolidate duplicated
journeys and seed unrelated prerequisites rather than moving coverage after
merge. The convergence sample-limit regression creates one background import
through the writer, then seeds additional open findings from that valid row;
all four foreground source orders still exercise their real import boundaries,
browser approval, and persisted projections. The PostgreSQL convergence suite
keeps all 24 source permutations and their projection assertions; the browser
journey owns the sample-limit regression, so integration setup does not replay
thirteen unrelated background imports. Finance category display fixtures
use the shared entity-kernel factory, preserving all 28 linked expense lines
without repeating unrelated HTTP create requests. Classification review also
seeds prerequisites through that factory; preview/apply, stale-review refusal,
explicit-purpose patches, refund quantities, and persisted classification still
cross their real application boundaries. The dedicated explanation-recovery
journey owns lazy loading, failure and retry, request counts, and phone evidence;
classification retains successful field and inherited-label explanations without
repeating the generic failure detour.

### Workerd test runtime and profiles

A PostgreSQL test file that starts workerd belongs in
`workerdIntegrationTests` (`apps/web/vitest.config.ts`), which forms the
`integration-workerd` project; CI runs it in the Worker build job against
that job's fresh bundle. An unlisted consumer fails in the ordinary integration
job.
The socket-lifecycle regression lives in that workerd integration project: it
exercises HTTP reads and freshness writes against the real Worker and observes
PostgreSQL socket expiry, without a browser. The runtime's
`poolIdleTimeoutMs` shortens the request pools' idle timeout; preserve quiet
windows longer than that timeout and the repeated-load assertions when
changing its scheduling. Purchase-agent harness profiles likewise shorten the
coordinator's settlement poll (`CUBBY_TEST_SETTLEMENT_POLL_MS`), so a
scripted Run never waits out production's ten-second interval.

Browser workers, Tester Army, native runners, the purchase-agent Vitest scenarios and the
live evals start the built Worker through `openWorkerdRuntime`
(`apps/web/tooling/workerd-runtime.ts`); a caller that runs work after
startup uses `withWorkerdRuntime`, which closes the runtime even when that
work throws. The runtime acquires the database (a lease it releases, or a
borrowed database it never closes), owned or borrowed object storage,
the profile's peers, and the harness into a native `AsyncDisposableStack`
(`await using`, then `move()` on success). `close()` releases them newest
first and runs every release even when one fails (failures chain as
`SuppressedError`); a start that fails at any step releases everything
acquired before it. Borrowed storage carries its S3
endpoint and public URL separately; neither startup failure nor close stops
caller-owned storage.

Scripted purchase-agent peers own the external models.dev catalog transport as
well as model responses. Their illustrative prices and complete token bounds
exercise the real paid-admission reservation; they never bypass pricing or
budget fences. Live-model peers forward catalog reads to models.dev. Keep this
distinction when adding a peer so deterministic mail discovery does not depend
on public catalog availability and live usage does not acquire fixture prices.

Every built-Worker journey uses `captureE2ERunIdentity` before scenario work
and `writeE2ERunBundle` after cleanup. A manual revision/build report alone
does not verify source stability across execution. The bundle records both
source boundaries, dirty-source limits, the exact replay command and checksums.

Before a new Worker journey or a fixture-correction replay, compare the complete
runtime options with the owning `WorkerdRuntimeOptions` and a working caller:
profile, database ownership, storage endpoint/public URL, and required peers.
Check the actor grant and retained-source authority through the existing fixture
helpers. Scripted paid peers still require an explicit synthetic execution approval
and complete synthetic pricing; bind the approval before dispatch and retain
per-transmission reservation assertions. Never bypass paid admission for a fixture.
Record startup failures as setup failures; behavioral red requires the
scenario to reach its failing boundary. Wrap runtime acquisition in the artifact
boundary so an exception before the scenario callback still records the failure
phase, scrubbed diagnostic, available build identity, and evidence checksums.

Native runners keep their build, process, simulator,
watchdog, scenario and artifact boundaries outside the runtime. Native
relation journeys scroll the navigation row back into view after inspecting
its badges, then wait for the destination detail marker before inspecting
inverse evidence. A successful tap alone does not establish navigation.
Rows with interactive facts expose a separate title identifier; navigation
tests target that title rather than the aggregate row, whose center can land
on a field explanation control.
Their `leaseNamedDatabase` backend in `test-database-lease.ts` creates and migrates
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
55432 endpoint: CI publishes it from native PostgreSQL service containers, and locally the
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

| Profile          | Used by                                   | `cubby-background` | `cubby-telemetry` | `cubby-purchase-agent` | Extra peers                    | Harness lock |
| ---------------- | ----------------------------------------- | ------------------ | ----------------- | ---------------------- | ------------------------------ | ------------ |
| `offline`        | browser default, simulator, Tester Army   | dropped            | dropped           | unconsumed             | none                           | no           |
| `gmail`          | `test.use({ workerdProfile: "gmail" })`   | real               | dropped           | unconsumed             | local Google provider          | no           |
| `native-import`  | Mac import lane                           | dropped            | dropped           | real                   | queue producer, model, gateway | yes          |
| `purchase-agent` | agent scenarios, live evals, browser spec | unconsumed         | real              | real                   | queue producer, model, gateway | yes          |
| `coupled`        | coupled Tester Army journeys              | real               | real              | real                   | queue producer, model, gateway | yes          |

Every profile includes `local-offline-peers` as the sink for dropped queues.
Durable Objects live in the built Worker and are real in every profile; the
harness seeds the synthetic USDA release into `USDA_RELEASES` before any USDA read. Starting a
profile throws when its routes and the compiled Worker's queue consumer names
differ in either direction. That check covers consumer queue names only, not
producers, Durable Objects, Hyperdrive, or service bindings, so it is not
exhaustive binding coverage; `tooling/workerd-runtime.integration.test.ts`
probes each profile's queues in a running harness.

A browser spec may declare `objectStoragePublicUrl` for an HTTPS source identity
while its bucket remains local. Its asset transport must forward requests to the
actual stored bytes; do not substitute an image or loosen capture URL guards.
The visible purchase-research journey uses that seam for retained catalog-image
reuse, real queue delivery, automatic child research, and UI provenance. Its
model decisions and Mac captures are scripted; it does not evaluate live research
quality, remote retailer image downloads, or Gmail discovery.

The harness lock is the one machine-wide lock above; only the profiles marked
"yes" take it (and rebuild a stale Worker). A Playwright run already holds it
from global setup and its workers pass through; other `offline` and `gmail`
callers run without it. Run one runtime per process at a time: it
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
process, simulator, watchdog, scenario and replay evidence.

A failed E2E test attaches the Worker harness's structured workerd logs
(`harness.getLogs()`, credential-shaped values scrubbed) to the Playwright
result, where the HTML report can open the attachment. The local reporter also
keeps its workerd logs and run bundle in `playwright-report`; CI excludes those
custom bundle files. Each Playwright worker prints
`<origin>/cdn-cgi/local/explorer` at startup, so a paused (`PWDEBUG`, headed, or
`--ui`) test can be inspected for Durable Object, queue, workflow, and R2 state.
The URL is only valid while that worker is alive.

Run `pnpm wasm` after WASM changes. The shared `CARGO_TARGET_DIR` can be
written by another checkout, so confirm generated output is current. Generated
API changes require the owning generated-surface workflow and affected native
checks.

Mapped database fixtures annotate the callback return with the table
`$inferInsert` type so enum literals retain their insert contract; passing a
runtime test does not verify TypeScript inference.
`insertWithShortcode` only supplies identity; it does not fill required entity
values, actor snapshots or execution identity. Prefer the existing admission
fixtures. A directly inserted Run used by public controls needs the complete
actor snapshot, agent session and dispatch identity. A cloned Run mints its own
Run UUID, shortcode, dispatch event and agent session; copied identity is a
fixture constraint failure. Researcher fixtures also
need typed input and its matching admitted roster. A fixture constraint
failure is not a behavior regression; correct it before implementing the fix.

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

List URLs in browser fixtures use the filter descriptor's declared `urlKey`
(for example, `q` for Expense and Purchase search). Assert the active filter
control and include unrelated records with a small page size when testing a
filtered record; an ignored filter can pass against a small local corpus and
hide the target behind pagination in CI.

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
the combined `Auxiliary tests and builds` lane, which every push would pay for; wire it into that
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

Instruction-only Recipe fixture sections omit the optional `ingredients` input;
when present, that input requires at least one ingredient. A cached Recipe Flow
fingerprint still includes `ingredients: []`, matching the persisted section
projection rather than the create input.

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
