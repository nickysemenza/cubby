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
| T2 Desktop/mobile shell | Complete | 208px expanded and 56px collapsed rail, 48px command band, five domain groups, preserved contextual mobile chrome, focused tests/typecheck, independent review, and desktop/mobile visual checkpoint |
| T3 Products reference workbench | Complete | Approved 28px Product density, docked inspector, Sheet, phone projection, one Product-owned relationship query, fixed direct/derived semantics, bounded previews, explicit provenance, and synthetic desktop/phone examples |
| T4 Canonical detail system | Complete | Product detail reuses the same relationship query near the hero and in its full route ledger, suppresses the generic duplicate explorer, and preserves recategorized project-use history as read-only evidence |
| T5 Canonical lists/details | Complete | Standard, direct-workbench, Project, Wishlist, Meal, and USDA rosters share the responsive inspector/mobile-detail contract; canonical details use one section ledger for Activity and truthful relationships, first-wave fallback previews are explicit, and read-heavy density is scoped rather than global |
| T6 Today/ordinary surfaces | Complete | Daily briefing hierarchy, truthful household signals, accessible question-led insights, responsive action targets, focused tests, full repository check, and independent closeout are recorded below |
| T7 Specialist workbenches | Complete | Specialist task models remain intact while calendar, physical, recommendation, cooking, collection, project, and diagnostic surfaces gain truthful recovery, phone projections/targets, focused tests, responsive review, and independent closeout |
| T8 Peripheral states | Complete | Public entry, OAuth, docs, offline, loading/error/not-found, account integrations, labels/print/export, generated PWA assets, phone geometry, focused tests, full check, and independent closeout are recorded below |
| T9 Hardening and finish | Complete | Whole-PWA polish, detector triage, 19/20 read-only audit, route matrices, recovery hardening, final synthetic screenshots, DESIGN.md/sidecar, production build, repository check, changed-test suite, full E2E, and independent CLEAR verdict |

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
| 2026-08-26 | T2 | Independent shell review | Pass after corrections | Confirmed 208px rail, 56px collapsed rail, 48px command band, safe-area/keyboard behavior; corrected Cook label contrast, Meals/Plan route truth, and obsolete shortened labels |
| 2026-08-26 | T2 | Products shell at desktop/mobile | Pass | `.impeccable/checkpoints/t2-shell/products-1440x900.png` and `products-430x932.png`; computed dimensions verified as 208px rail and 48px command band |
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
| 2026-08-26 | T5 | Remaining roster and compact-preview coverage | Pass | Meals and USDA Foods now use intentional responsive inspector/mobile projections; Financial Account, Financial Transaction, Wish, and Image provide honest compact previews without embedding full details or duplicating Open actions |
| 2026-08-26 | T5 | Canonical detail composition | Pass | Image, Recipe, and Cookbook details use one `DetailSections` ledger; Cookbook retains its physical-copy and recipes/ingredients workflows while gaining Activity, and generic details append one relationship section without duplicating Product's page-owned route |
| 2026-08-26 | T5 | Shared relationship route contract | Pass | One cached bounded preview adapter feeds generic inspector Overview, canonical detail, and the full relationship explorer; it renders the actual linked source record through one real relation to sibling endpoints, sits directly below the detail section index, suppresses Product's specialist contract, and leaves branch pagination lazy |
| 2026-08-26 | T5 | Density and domain-wayfinding policy | Pass | Dense first visits are explicit only for canonical read-heavy Products, Vendors, Transactions, Cookbooks, USDA Foods, and Wishlist rosters; stored preference still wins, editable/multiline tables remain compact, and entity marks resolve through the five domain colors |
| 2026-08-26 | T5 | Final focused UI suite | Pass: 124 tests in 23 files | Covers roster plumbing, canonical mobile identity, compact previews, route-model truth, detail ledgers, density defaults, domain marks, Product suppression, named and unnamed Meal identities, USDA projections, and shared control regressions |
| 2026-08-26 | T5 | Desktop/phone relationship and Meal review | Pass | Live Vendor inspector and detail show one bounded route preview plus the full lazy relationship tree at 1440×1000 and 430×932 with no page overflow; Meal name control measures 414×44px at 430px. Private household data was inspected only in place; no capture was retained |
| 2026-08-26 | T5 | `pnpm check` | Pass | Entity/start-operation generators, workspace and service-worker types, changed-file formatting, SQL safety, soft-delete coverage, and unsafe-identifier guards are green |
| 2026-08-26 | T5 | Independent adversarial closeout | Pass: no P1/P2 | Final review verified direct-phone route placement, real canonically linked source identity including unnamed Meal date fallback, no added identity fetch, lazy relationship branches, Product suppression, Vendor dense first visit, and stored-density precedence |
| 2026-08-26 | T6 | Attention-first Today composition | Pass | Today now reads as context, ranked Next up, Meals ahead, four canonical daily passes, household signals, change history, then opt-in records and insights; specialist actions retain their canonical routes |
| 2026-08-26 | T6 | Truthful signal and recovery states | Pass | Pantry value exposes named Location evidence; spend explicitly compares current month-to-date with the prior full calendar month; meals, tasks, pantry, spend, activity, and all four insights distinguish loading, empty, and error/retry states |
| 2026-08-26 | T6 | Accessible question-led insights | Pass | Each chart names its question, exposes a textual summary, and provides canonical record links; compact ingredient usage no longer repeats its heading, uncategorized products route to the unfiltered roster, and phone links measure at least 44px |
| 2026-08-26 | T6 | Responsive rendered-state review | Pass | Live populated Today was inspected at 1440×1000, 844×390, 430×932, and 320×568 with no page overflow; phone primary actions measured 44px and preserved briefing order. Private household data was inspected only in place; no capture was retained |
| 2026-08-26 | T6 | Focused UI tests and typecheck | Pass: 13 tests in 7 files | Covers bounded task briefing evidence and phone-link classes, meals recovery, problem severity, spend context, lazy activity geometry, audit empty/error behavior, and insight metric/drilldown contracts; `pnpm typecheck:web` also passed |
| 2026-08-26 | T6 | `pnpm check` | Pass | Entity/start-operation generators, workspace and service-worker types, changed-file formatting, SQL safety, soft-delete coverage, and unsafe-identifier guards are green |
| 2026-08-26 | T6 | Independent adversarial closeout | Pass after four P2 corrections; no residual P1/P2 | Replaced the full actionable-graph Home fetch with bounded `task.todayBriefing` plus parity coverage, aligned location language with item-count sizing, preserved nullable Product category drilldowns through the real route schema, and applied explicit 44px phone task/project link targets |
| 2026-08-26 | T7 | Calendar recovery | Pass | Range-query failures suppress false empty calendar/agenda projections and expose an accessible phone-safe Retry action; empty actions and existing view controls retain 44px phone targets |
| 2026-08-26 | T7 | Physical workflow error truth | Pass | Photo Pass preserves scanner/scope/resume state while distinguishing lookup/tree failures from empty/completed work; Inventory Session blocks recount/save when tree or expected-inventory snapshots fail; Scan retains its manual fallback |
| 2026-08-26 | T7 | Recommendation recovery | Pass | Placement, tag propagation, product relatedness, and duplicate-product panels distinguish failures from unavailable/stale-index states, expose phone-safe recovery, and allow direct workbench entry without flattening specialist structure |
| 2026-08-26 | T7 | Project timeline projections and dependencies | Pass | The full split-pane Gantt remains at `md` and wider; phones receive a chronological task/subproject agenda from the same subtree data, including end-only dates. Desktop Links buttons expose named predecessor/successor summaries through reliable pointer and native keyboard activation |
| 2026-08-26 | T7 | Cooking workbench states | Pass | Ingredient enrichment errors no longer coexist with false success-empty copy, usage tables scroll within their mobile surface, and Recipe Compare removal controls are record-specific 44px phone targets |
| 2026-08-26 | T7 | Collection assignment projection | Pass | Desktop retains the cross-tab matrix; phones receive subject/collection selectors, a bounded 25-row projection with direct/inherited truth, paging, first-collection creation, canonical row links, and 44px controls |
| 2026-08-26 | T7 | Specialist control and diagnostic recovery | Pass | Arrange, Photo Pass, and background-job controls are phone-safe; cached list/child failures remain visible with local Retry actions, including the selected batch summary |
| 2026-08-26 | T7 | Responsive rendered-state review | Pass | Calendar, Inventory Session, Photo Pass, recommendation entry, and collection assignments were inspected at 320px or 430px without page overflow; the assignment matrix was also checked at 1280px to preserve its desktop table. Private household data was inspected only in place; no capture was retained |
| 2026-08-26 | T7 | Changed-test suite | Pass: 37 tests in 9 files | Exact changed-test inventory covers collections, recipe comparison, ingredient enrichment, recommendation routing, background diagnostics, project phone agenda/date semantics, and Gantt relationship resolution/activation |
| 2026-08-26 | T7 | `pnpm check` | Pass | Exact-head entity/start-operation generators, workspace and service-worker types, changed-file formatting, SQL safety, soft-delete coverage, and unsafe-identifier guards are green |
| 2026-08-26 | T7 | Independent adversarial closeout | Pass after corrections; no residual P1/P2 | Corrected four initial state/first-use/date findings, selected-summary recovery, and the Gantt focus/click double-toggle; final review verified one activation opens and the next closes for pointer and native keyboard-generated clicks |
| 2026-08-26 | T8 | Public entry and OAuth recovery | Pass | Auth and consent use a deterministic shared entry frame; OAuth consent verifies the exact requested client identity, treats all error payloads as retryable failure, rejects stale-route state, and keeps Allow disabled without an exact match |
| 2026-08-26 | T8 | Docs, route, and entity recovery | Pass | Documentation loading/failure/not-found, route error, application not-found, invalid shortcode, and missing canonical-entity states use sentence-case Porcelain surfaces with truthful 44px recovery actions |
| 2026-08-26 | T8 | Peripheral loading and offline states | Pass | Shared route-pending geometry, 1px skeletons, offline recovery, and public footer/header materials replace remaining old-world treatments without introducing a dark-mode branch |
| 2026-08-26 | T8 | Account, integration, and calendar recovery | Pass | Connected-app discovery, calendar feed lookup, and orphaned OAuth-client counts distinguish request failure from valid empty/zero states and expose local Retry actions |
| 2026-08-26 | T8 | Label print/export hardening | Pass | Lookup failure fails closed even when sibling results succeed, Print/CSV and the print portal remain unavailable on error, invalid-code counts stay truthful, and the fixed physical sheet is isolated inside a focusable internal scroller |
| 2026-08-26 | T8 | PWA palette and generated assets | Pass | Root metadata, manifest, offline document, favicon, install icons, maskable icons, and 11 splash images use the Porcelain canvas and mark; `pnpm --dir apps/web gen:pwa-assets` regenerated and verified the asset family |
| 2026-08-26 | T8 | Responsive rendered-state review | Pass | Auth/OAuth/docs at 320px and offline/settings/connected apps/invalid shortcode/route error/labels at 430px were inspected without page overflow; interactive phone targets measured 44px and private household data was inspected only in place |
| 2026-08-26 | T8 | Final focused UI suite | Pass: 29 tests in 13 files | Covers exact-ID consent, docs states, label export/print geometry, entity routing, orphan maintenance, footer targets, loading skeletons, PWA metadata, calendar feed recovery, and recipe export/search behavior |
| 2026-08-26 | T8 | `pnpm check` | Pass | Exact-head entity/start-operation generators, workspace and service-worker types, changed-file formatting, SQL safety, soft-delete coverage, and unsafe-identifier guards are green |
| 2026-08-26 | T8 | Independent adversarial closeout | Pass after seven P2 corrections; no residual P1/P2 | Reviewer verified exact-ID OAuth gating, mixed-error export suppression, internal paper scrolling, synchronized PWA palette/assets, missing-detail recovery, orphan-count recovery, and both footer targets at `13a5340d6` |
| 2026-08-26 | T9 | Whole-PWA polish and truth-state hardening | Pass | Search, AI Usage, and MCP catalog now distinguish loading, empty, and failure states with local Retry actions; shared phone controls, Arrange, relationship trees, and task cards meet the 44px target contract |
| 2026-08-26 | T9 | Impeccable detector and classification | Pass: no unresolved P0/P1 | One prescribed detector run identified stale docs, intentional Inter usage, test-fixture false positives, justified Canvas/offline boundaries, and real thick-rule/Canvas residues; the real findings were corrected and the detector was not rerun |
| 2026-08-26 | T9 | Read-only Impeccable audit | Pass: 19/20; no residual P1/P2 | Accessibility 3/4 conservatively reflects the absence of a fresh whole-PWA automated WCAG crawl; performance, responsive behavior, theming, and implementation integrity scored 4/4 after the independent review corrections |
| 2026-08-26 | T9 | Whole-PWA rendered route matrices | Pass | Fourteen core routes were inspected at 430px and 1440px; operations and cooking specialists were inspected at phone width; Scan was checked at 844×390; no accidental page overflow or undersized visible control remained. Private household data was inspected only in place and not captured |
| 2026-08-26 | T9 | Final synthetic screenshot set | Pass | `.impeccable/checkpoints/t9-finish/` contains privacy-safe Products workbench, phone roster, and phone Product detail captures; the detail capture shows the truthful Product → Stock → Location route |
| 2026-08-26 | T9 | Production build and PWA precache | Pass | `pnpm --dir apps/web build` passed after generated PWA images were stripped and quantized; service-worker precache is 1,231,649 gzip bytes against the 1.35 MiB budget |
| 2026-08-26 | T9 | `pnpm check` | Pass | Entity/start-operation generators, workspace and service-worker types, changed-file formatting, SQL safety, soft-delete coverage, and unsafe-identifier guards are green |
| 2026-08-26 | T9 | `pnpm test:changed origin/main` | Pass: 306 files, 2,110 tests | Two stale `text-plum` assertions from the first run were corrected to the canonical House-domain token; the exact corrected tier passed in 104.19s |
| 2026-08-26 | T9 | Full Playwright E2E | Pass on bounded retry | The first attempt failed in global setup with a transient Better Auth empty-500 response and ran zero tests; one bounded retry completed the full suite and teardown successfully |
| 2026-08-26 | T9 | Shipped design contract | Pass | `apps/web/DESIGN.md` and `.impeccable/design.json` describe the same Porcelain Transit visual world, density asymmetry, domain wayfinding, entity-route interaction, responsive behavior, and intentional boundaries |
| 2026-08-26 | T9 | Independent finish review and re-review | CLEAR at `aab715ef4` after three P2 corrections | Moved the actual canonical phone-row link/button to a 44px target with direct regression coverage, replaced thirteen retired 3px production separators with 1px hairlines while preserving the semantic 2px Gantt edge, and reconciled every route-family coverage row with its completed implementation/verification/review evidence; Sol found no residual P1/P2 in the bounded correction diff |

## T9 final visual checkpoint

All files in `.impeccable/checkpoints/t9-finish/` use synthetic placeholder
records. No household or production data is present.

| Surface | Evidence |
| --- | --- |
| Dense Products workbench at desktop | `products-workbench-1440x900.png` |
| Products list projection at phone width | `products-mobile-430x932.png` |
| Product detail and relationship route at phone width | `product-detail-mobile-430x932.png` |

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
The operation stays within the deterministic statement budget enforced by
`apps/web/src/server/repo/product/relationship-route.integration.test.ts`.
That budget may be tightened through later query consolidation, but not weakened
to reintroduce client fan-out or dilute the fixed contract.

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

The standard `EntityListPage` batch covers Locations, Recipes, Tasks, Vendors,
Financial Accounts, Financial Transactions, and Images. Direct preview owners
cover Cookbooks, Ingredients, Inventory's table view, Purchases, and Expenses.
The bespoke batch covers Project tree/flat views, Meals, USDA Foods, and
Wishlist's heterogeneous Wish/Product tree. Namespaced row keys remain distinct
from canonical Wish or Product targets, so expanding a candidate neither
highlights the parent nor opens the wrong entity on desktop or phone.

Generic routes now share one bounded relationship-preview model: the actual
canonically linked source record, a labeled real relation, and at most three
sibling endpoints. Inspector Overview, the route directly below a detail's
section index, and the full explorer reuse cached queries; deeper branches load
only after an explicit tree action. Product retains its approved domain-owned
route and is suppressed from this generic composition.

Image, Recipe, and Cookbook details now use the shared section ledger without
nested indexes or duplicate relationship/activity content. The first-wave
Financial Account, Financial Transaction, Wish, and Image compact summaries are
explicit rather than fabricated. Read-heavy first-visit density is opt-in and
stored preference still wins. Specialist workbenches and ordinary dashboard
surfaces remain intentionally bounded to T6–T8.
