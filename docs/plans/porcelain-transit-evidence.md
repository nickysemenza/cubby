# Porcelain Transit Evidence Ledger

This ledger is the execution record for
[`porcelain-transit-ui-overhaul.md`](./porcelain-transit-ui-overhaul.md). A
status becomes `Complete` only when the linked evidence exists on the current
branch.

## Baseline

- Branch: `codex/porcelain-transit-ui`
- Rebased base: `origin/main` at `a8c4c06b4`
- Rebase verified: 2026-08-25, `HEAD...origin/main` = `0 0`
- Initial application edits: none
- Planning assets were preserved from the detached worktree before rebasing.

## Known external dependency

The user has an inflight E2E stabilization branch that will be proposed
separately. Current remote evidence identifies it as
`origin/codex/stabilize-inline-editor-e2e` at `92315b6d5`; it bounds inline
editor `fill` and `Enter` actions inside the retry loop.

Until that work lands:

- Do not weaken, delete, or speculatively rewrite inline-editor E2E coverage to
  make this redesign green.
- Attribute a failure to the inflight fix only when its exact error and touched
  helper match that branch's change.
- Continue to fix redesign-caused failures.
- Rebase the completed stabilization PR before final exact-head validation, or
  explicitly prove that its change is already present in `main`.

## Target ledger

| Target | Status | Evidence |
| --- | --- | --- |
| T0 Governance and baselines | Complete | Branch/base above; approved mocks, calibration, truth matrix, and 18 source-state screenshots are committed together |
| T1 Tokens, fonts, and primitives | Pending | — |
| T2 Desktop/mobile shell | Pending | — |
| T3 Products reference workbench | Pending | — |
| T4 Canonical detail system | Pending | — |
| T5 Canonical lists/details | Pending | — |
| T6 Today/ordinary surfaces | Pending | — |
| T7 Specialist workbenches | Pending | — |
| T8 Peripheral states | Pending | — |
| T9 Hardening and finish | Pending | — |

## T0 required evidence

- [x] Dedicated branch created from the planning worktree.
- [x] Branch rebased onto current `origin/main`.
- [x] Approved desktop mocks and sidecars preserved.
- [x] Impeccable surface brief registered for `apps/web`.
- [x] Products relationship truth matrix documented.
- [x] Desktop/mobile calibration behavior documented.
- [x] Warm-Paper baseline screenshots captured at the required routes and
      viewports.
- [x] Planning artifacts formatted and visually reviewed; this ledger is part
      of the same T0 commit.

### Baseline screenshot matrix

The source UI is captured before T1. All fixtures are synthetic.

| Route | 1440×900 | 430×932 | 320×568 |
| --- | --- | --- | --- |
| `/` | `today-1440x900.png` | `today-430x932.png` | `today-320x568.png` |
| `/products` | `products-1440x900.png` | `products-430x932.png` | `products-320x568.png` |
| Product detail | `product-detail-1440x900.png` | `product-detail-430x932.png` | `product-detail-320x568.png` |
| `/locations` | `locations-1440x900.png` | `locations-430x932.png` | `locations-320x568.png` |
| `/scan` | `scan-1440x900.png` | `scan-430x932.png` | `scan-320x568.png` |
| `/settings` | `settings-1440x900.png` | `settings-430x932.png` | `settings-320x568.png` |

All files live in `.impeccable/baselines/warm-paper/`. Full-page capture is
intentional, so long Product detail and Today screenshots exceed the viewport
height while retaining the named viewport width.

### Source-state observations

- `/` at 320×568 renders the household dashboard but does not expose the
  authenticated shell hydration marker used by the shared E2E helper. The
  baseline waits for the rendered `Welcome home.` heading instead; production
  code was not changed during T0.
- Product detail's existing secondary queries can surface `UNKNOWN_ERROR` and
  loading placeholders in the hermetic harness. Those states are preserved in
  the source baseline and are not treated as redesign output.
- Product rows differ between viewport captures because each synthetic detail
  fixture is created in sequence. No household or production data is present.

## Validation log

| Date | Target | Command/check | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-08-25 | T0 | `git rev-list --left-right --count HEAD...origin/main` | Pass: `0 0` | Rebased before application edits |
| 2026-08-26 | T0 | `pnpm --filter @cubby/web run build:cf` | Pass | Production Worker build and bundle analysis completed before source capture |
| 2026-08-26 | T0 | Focused Playwright baseline capture | Pass: 18 PNGs | 17-route batch plus bounded `/` 320×568 capture after documenting its existing hydration-marker mismatch |
| 2026-08-26 | T0 | Visual review of Products, Product detail, and Today at desktop/mobile | Pass | Captures are readable, synthetic, and represent the pre-overhaul Warm-Paper state |
