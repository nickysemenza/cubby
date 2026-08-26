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
| T3 Products reference workbench | Complete | Approved 28px Product density, docked inspector, Sheet, phone projection, one Product-owned relationship query, fixed direct/derived semantics, bounded previews, explicit provenance, and synthetic desktop/phone examples |
| T4 Canonical detail system | Complete | Product detail reuses the same relationship query near the hero and in its full route ledger, suppresses the generic duplicate explorer, and preserves recategorized project-use history as read-only evidence |
| T5 Canonical lists/details | In progress | Standard, direct-workbench, Project, and heterogeneous Wishlist rosters now share one responsive current-record inspector contract; canonical detail compositions and actions remain under review |
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
| 2026-08-26 | T3–T4 | Product relationship contract integration tests | Pass | Covers exact counts, capped previews, source attribution, soft deletes, acquisition filtering, derived Project/Vendor evidence, and historical project-use reads after recategorization; mutation guards remain category-bound |
| 2026-08-26 | T3–T4 | Relationship and shared-detail UI tests | Pass | Covers direct/derived labels and zero states, inspector reuse, page-owned relationship replacement, read-only historical project uses, and retained reusable-category edit affordances |
| 2026-08-26 | T3–T4 | `pnpm typecheck:web` and `pnpm check` | Pass | Contract and historical-use commits pass web/workspace type checks and the full repository check |
| 2026-08-26 | T3–T4 | Synthetic relationship-route visual review | Pass | Public-placeholder desktop and phone examples confirm compact strip, bounded branches, provenance, derived separation, horizontal phone scrolling, and 44px phone targets |
| 2026-08-26 | T5 | Generic inspector and responsive preview tests | Pass: 27 tests in 5 files | Covers lazy capability-gated tabs, per-record state reset, canonical Open/Close actions, named dialogs, hover prefetch, legacy Sheet compatibility, wide dock, intermediate Sheet, mobile suppression, current-row forwarding, heterogeneous Wish/Product identities, and Strict Mode relationship reference semantics |
| 2026-08-26 | T5 | `pnpm typecheck:web` and `git diff --check` | Pass | Generic inspector, responsive selection seam, first sibling-list integration, and relationship-cycle correction are type/whitespace clean |
| 2026-08-26 | T5 | Responsive canonical roster visual review | Pass for first batch | A standard Vendor roster was manually verified at 1440×900 (dock), 1024×768 (Sheet), and 430×932 (direct canonical card links); no private-data capture was retained |
| 2026-08-26 | T5 | Direct-roster inspector propagation | Pass | Cookbooks, Ingredients, Inventory table view, Purchases, and Expenses now opt into the same current-row dock/Sheet/phone contract; alternate views and embedded ledgers remain untouched |
| 2026-08-26 | T5 | Direct-roster desktop visual review | Pass | A representative Purchase roster was manually verified with a compact 25rem inspector and canonical Overview/Relations/Activity content at 1440×900; no private-data capture was retained |
| 2026-08-26 | T5 | Bespoke-roster inspector propagation | Pass | Project tree/flat views and Wishlist's heterogeneous Wish/Product tree now preserve canonical entity identity separately from TanStack row identity while using the shared responsive inspector |
| 2026-08-26 | T5 | Wishlist parent/child visual review | Pass | At 1440×900, a Wish row opened the honest fallback inspector and its expanded Product candidate opened a Product inspector with the candidate shortcode and selected-row treatment; no private-data capture was retained |

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
| Synthetic relationship route at desktop | `product-route-synthetic-1440x900.png` |
| Synthetic relationship route at phone | `product-route-synthetic-430x932.png` |

Relationship drawing remains evidence-gated. One Product-owned public operation
returns exact branch counts, at most three previews, canonical shortcodes, and
explicit provenance. Stock and identity Locations, Expenses and Purchases, used
on and purchased-for Projects, Tasks, and derived Vendors remain distinctly
named rather than flattened into a decorative graph or inferred in the client.
The operation currently executes fifteen bounded repository statements in
parallel. That is acknowledged performance debt for later query consolidation,
not permission to reintroduce client fan-out or weaken the fixed contract.

### Checkpoint decision

On 2026-08-26 the user approved and asked to deepen the Porcelain Transit
direction. The resulting `product.relationshipRoute` contract and UI are now
the T5 replication standard: one client query, direct evidence before derived
rollups, no false chains, stable canonical links, explicit zero/error states,
and read-only preservation of historical evidence when a Product category
changes. The earlier payload-only route remains baseline evidence, not the
current contract.

## T5 migration progress

The first shared batch extends Product's three-level inspection rhythm without
copying its Product-owned relationship semantics. `EntityListPage` rosters now
select one current record independently of bulk selection and render:

- a 25rem compact inspector dock at 1280px and wider;
- the same composition in a right Sheet from 768–1279px; and
- no inspector on phone, where semantic cards keep their canonical detail
  links.

The generic inspector uses compact manifest overviews, the registered
relationship explorer, and audit history behind capability-gated lazy tabs. It
never mounts a complete detail page inside a dock. Unsupported compact overview
types state that limitation and keep the canonical Open action instead of
inventing summary fields.

The first integration covers the standard `EntityListPage` rosters: Locations,
Recipes, Tasks, Vendors, Financial Accounts, Financial Transactions, and Images.
The next mechanical batch extends it to existing direct preview owners:
Cookbooks, Ingredients, Inventory's table view, Purchases, and Expenses. The
bespoke batch covers Project tree/flat views and Wishlist's heterogeneous
Wish/Product tree. Its namespaced row keys remain distinct from the canonical
Wish or Product target, so expanding a candidate neither highlights the parent
nor opens the wrong entity.

Products retain their approved domain-owned inspector. The remaining T5 work is
therefore canonical detail composition, action placement, and honest compact
summaries for entity types whose manifest currently exposes no preview fields;
specialist workbenches and ordinary dashboard surfaces remain bounded to later
targets.
