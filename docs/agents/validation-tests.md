# Test tiers and runtime traps

Use unit tests for pure logic, UI tests for rendered behavior, PostgreSQL tests
for constraints/transactions/query behavior, and E2E for the built browser
application. A `.tsx` change under `apps/web/src` needs the UI tier. Keep pure
logic imported by node tests in alias-free `.ts` files.

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

Run `pnpm wasm` after WASM changes. The shared `CARGO_TARGET_DIR` can be
written by another checkout, so confirm generated output is current. Generated
API changes require the owning generated-surface workflow and affected native
checks.

## Affected-only E2E for local iteration

`pnpm --dir apps/web test:e2e:affected` runs only the specs the current diff
plausibly touches, for a faster local loop than the full suite —
`apps/web/tests/e2e/spec-areas.ts` maps each spec to the routes, feature
dirs, and shared contract files it exercises, and `scripts/e2e-affected.ts`
matches changed files (committed since `origin/main` plus the working tree)
against it. A change to a shared seam (the entity kernel, the app shell,
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
