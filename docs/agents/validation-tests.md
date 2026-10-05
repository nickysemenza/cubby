# Test tiers and runtime traps

Prefer E2E for complete behavior through the built browser application or the
native client. Keep a focused unit, UI, PostgreSQL, or Workers test when it
catches a concrete failure the available E2E suites do not reasonably observe.
Before adding an isolated test, record its failure modes and write the failing
test before the code. For `.tsx` changes, choose browser E2E when it observes
the behavior; use the UI or preview tier for distinct rendering or layout
failures. Keep pure logic imported by node tests in alias-free `.ts` files.

`pnpm test` runs fast unit, UI, contract, and auxiliary tests; `pnpm
test:postgres` runs contract tests; `pnpm test:e2e` runs PostgreSQL-backed
browser tests; `pnpm test:all` runs fast, PostgreSQL, then Playwright
sequentially. Do not overlap PostgreSQL and E2E locally: they contend for
containers, workerd, browsers, and database connections. Other workspace
packages need `pnpm -r --filter '!@cubby/web' run test` after changing
`packages/*`.

Target a browser spec as `pnpm test:e2e <spec>` without an extra `--`. E2E
serves `dist/`, so build it before a standalone run; `verify:local` does. A
standalone Playwright request context inherits project storage state unless it
sets empty cookies and origins. RTable's placeholder transition can eat clicks;
cell-edit tests retry opening and filling as one action.

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

## Affected-only E2E for local iteration

`pnpm --dir apps/web test:e2e:affected` runs only the specs the current diff
plausibly touches, for a faster local loop than the full suite —
`apps/web/tests/e2e/spec-areas.ts` maps each spec to the routes, feature
dirs, and shared contract files it exercises, and `apps/web/scripts/e2e-affected.ts`
matches changed files (committed since `origin/main` plus the working tree)
against it. The routes and feature dirs a spec visits are generated into
`spec-areas.derived.ts` (`node scripts/generate-spec-areas.ts` from `apps/web`;
`e2e-affected.unit.test.ts` fails when it drifts); server, contract, and shared
component globs stay hand-written in `SPEC_EXTRA_GLOBS`. A change to a shared seam (the entity kernel, the app shell,
`e2e-helpers.ts`, etc.) or anything the manifest can't place selects every
spec instead of guessing narrow. `--list` prints the selection without
running it. This is local-only: CI keeps running the full suite, and this is
not a merge gate.

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
