# Porcelain Transit Evidence Ledger

This ledger is the execution record for
[`porcelain-transit-ui-overhaul.md`](./porcelain-transit-ui-overhaul.md). A
status becomes `Complete` only when the linked evidence exists on the current
branch.

## Baseline

- Branch: `codex/porcelain-transit-ui`
- Rebased base: `origin/main` at `8ca2408ef`
- Rebase verified: 2026-08-26; the two Porcelain Transit commits rebased cleanly and the uncommitted T2 shell diff was restored without conflict
- Initial application edits: none
- Planning assets were preserved from the detached worktree before rebasing.

## Resolved external dependency

The user's E2E stabilization work landed on `main` as `8ca2408ef`
(`test(e2e): preserve inline editor retries (#923)`) before the T2 checkpoint.
It bounds inline-editor `fill` and `Enter` actions inside the retry loop.

The redesign continues to treat that helper and coverage as upstream-owned:
do not weaken, delete, or speculatively rewrite it to make visual work green;
fix only redesign-caused failures.

## Target ledger

| Target | Status | Evidence |
| --- | --- | --- |
| T0 Governance and baselines | Complete | Branch/base above; approved mocks, calibration, truth matrix, and 18 source-state screenshots are committed together |
| T1 Tokens, fonts, and primitives | Complete | Shared raw tokens, Inter-led typography, domain palette, modest geometry, restrained overlays, rebuilt core primitives, and desktop/mobile state gallery |
| T2 Desktop/mobile shell | Complete | 224px expanded and 56px collapsed rail, 48px command band, five domain groups, preserved contextual mobile chrome, focused tests/typecheck, independent review, and desktop/mobile visual checkpoint |
| T3 Products reference workbench | Checkpoint | Products-only 28px first-visit density, current/bulk state separation, full-height 400px docked inspector, 1024px Sheet, 430px canonical cards, active-only tabs, canonical Inventory/Location stations, and direct/derived section ordering are implemented and captured below; awaiting user direction approval |
| T4 Canonical detail system | Checkpoint | Product detail reuses the relationship route, domain-spined identity hero, plain-language metadata/stats, responsive Sections index, normal-density content, and canonical phone flow; awaiting user direction approval |
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
| 2026-08-26 | T1 | Token contrast calculation | Pass | Graphite/canvas 16.51:1; secondary/surface 4.97:1; cobalt/white 5.17:1; positive/white 4.68:1; warning ink/white 6.56:1; destructive/white 5.17:1 |
| 2026-08-26 | T1 | `pnpm typecheck` | Pass | All 12 workspace package checks plus root TypeScript check |
| 2026-08-26 | T1 | Focused domain-wayfinding and Button unit tests | Pass: 12 tests | Includes Product→Pantry classification and 44px phone target guard |
| 2026-08-26 | T1 | `pnpm --filter @cubby/web run build:cf` | Pass | Production app, service worker, MCP widgets, and bundle analysis |
| 2026-08-26 | T1 | Primitive gallery at `/design` | Pass | `.impeccable/checkpoints/t1-foundation/design-1440x900.png` and `design-430x932.png`; visually reviewed at both viewports |
| 2026-08-26 | T2 | Rebase onto latest `origin/main` | Pass | Base is `8ca2408ef`; both committed UI changes rebased and the six-file shell diff restored without conflict; upstream now includes E2E retry PR #923 |
| 2026-08-26 | T2 | Navigation and workspace-navigator focused tests | Pass: 36 tests | Covers route uniqueness, domain/group agreement, full expanded-rail labels, search, and navigator rendering |
| 2026-08-26 | T2 | `pnpm typecheck:web` and `git diff --check` | Pass | Web and service-worker TypeScript checks are clean after reviewer corrections |
| 2026-08-26 | T2 | Independent shell review | Pass after corrections | Confirmed 224px rail, 56px collapsed rail, 48px command band, safe-area/keyboard behavior; corrected Cook label contrast, Meals/Plan route truth, and obsolete shortened labels |
| 2026-08-26 | T2 | Products shell at desktop/mobile | Pass | `.impeccable/checkpoints/t2-shell/products-1440x900.png` and `products-430x932.png`; computed dimensions verified as 224px rail and 48px command band |
| 2026-08-26 | T3–T4 | Focused UI tests | Pass: 23 tests in 9 files | Covers inspector tabs/lazy activity, canonical stations, current-vs-bulk state, scoped density, workbench forwarding, detail index, mobile canonical links, toolbar, hero, and compact mobile view controls |
| 2026-08-26 | T3–T4 | `pnpm typecheck:web`, `pnpm format:changed`, and `git diff --check` | Pass | Web/service-worker types, formatting, and patch whitespace are clean after midpoint corrections |
| 2026-08-26 | T3–T4 | Adversarial midpoint review | Corrections applied; user checkpoint remains | Scoped dense default to Products, removed duplicate intermediate inspector mount and generic Vendors-first graph, added `aria-current`, canonical Inventory/Location station links, 44px phone stations, mobile density forwarding, and modernized shared detail language/index |
| 2026-08-26 | T3–T4 | Desktop/tablet/mobile visual matrix | Pass for checkpoint | True PNGs captured at 1440×900, 1024×768, and 430×932; inspector, Sheet, Product detail, relationship ordering, and phone flow manually reviewed |

## T3–T4 mandatory checkpoint

All files live in `.impeccable/checkpoints/t3-products/`:

| Surface | Evidence |
| --- | --- |
| Dense Products workbench + docked Overview inspector | `products-workbench-relationship-1440x900.png` |
| Product-specific direct/derived Relations index | `products-workbench-relations-1440x900.png` |
| Intermediate right Sheet | `products-workbench-sheet-1024x768.png` |
| Canonical Product detail | `product-detail-1440x900.png` |
| Phone Products projection | `products-mobile-430x932.png` |
| Phone canonical Product detail | `product-detail-mobile-430x932.png` |

Relationship drawing remains evidence-gated: the Overview/detail payload proves
Product→InventoryEntry and Product→Location, so those stations link directly to
their canonical records. Purchase, Expense, Vendor, Project, and Task journeys
remain distinctly named and ordered in the Relations tab, but do not draw
decorative count edges or trigger a multi-query fan-out merely to populate the
Overview. The user checkpoint decides whether this truthful restrained route is
the replication standard or whether T3 should add a dedicated aggregated
relationship-summary contract before T5.
