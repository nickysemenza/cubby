# Porcelain Transit UI Overhaul

Status: **In progress; T0–T4 complete, T5 canonical-route migration next**

Delivery: **One big-bang branch and one ready-for-review PR**

Primary target: `apps/web` (the entire web PWA)
Approved references:

- [Route-led shell composition](../../.impeccable/mocks/porcelain-transit-route-led.png)
- [Table-first density and inspector composition](../../.impeccable/mocks/porcelain-transit-table-first.png)

The approved composition is a deliberate fusion: the route-led reference owns
the expanded shell, domain wayfinding, and horizontal relationship path; the
table-first reference owns grid density, the collapsed rail, and the vertical
inspector spine. Generated records, counts, statuses, prices, and navigation
labels are layout placeholders, not product requirements.

## 1. Objective

Replace Cubby's Warm-Paper Ledger visual world across the complete web PWA with
**Porcelain Transit**: clean light-mode operational software with expressive,
stable domain wayfinding, ultra-dense desktop tables, normal-density non-table
content, native-feeling mobile flows, docked desktop inspectors, and truthful
entity relationships as the signature interaction.

The overhaul changes presentation and composition, not Cubby's product truth.
It must preserve existing route semantics, workflows, data contracts, table
capabilities, keyboard behavior, mobile navigation, safe-area handling,
accessibility, and domain tenets.

## 2. Direction contract

**THESIS:** Cubby is a household transit system: records are stations and real
relationships are routes. Refuse both the generic KPI-card dashboard and the
nostalgic paper ledger.

**OWN WORLD:** Porcelain-white planes, graphite type, cool structural grays,
modest radii, fine borders, cobalt interaction, and five expressive domain
lines. Tables remain calm; navigation, selection, relationships, charts, and
meaningful state carry color.

**STORY:** See what needs attention, scan the records, select one without losing
place, understand how it connects, then act or open the complete record.

**FIRST VIEWPORT:** Collapsible domain rail at left, compact command/query bands,
a 28px-row Products grid filling the center, and a docked inspector at right.
The selected record's route connects Product, Inventory/Location, Purchase, and
Project where those relationships actually exist.

**FORM:** Route-led workbench fused with table-first dispatch. Impeccable seed
key `cfd7bb77`. FINISH: unreviewed and undocumented is unfinished; this build
ends with the finish review, the verdict, and DESIGN.md.

## 3. Non-negotiable product invariants

- Inventory never auto-decrements; the interface must not imply automated stock
  truth that Cubby does not maintain.
- `fdc_id` remains Product-only.
- Rare imports, repair, and reconciliation work remains explicitly interactive.
- Money summaries remain grounded in `SUM(Expense.cost)` and must not quietly
  substitute Purchase totals or synthetic dashboard metrics.
- One trusted household means no multi-user coordination, locks, reservations,
  restore/undo system, or SaaS workspace theater.
- Existing URLs, saved table views/layouts, filters, deep links, and semantic
  mobile back behavior remain compatible unless this plan explicitly says
  otherwise.
- Public fixtures, screenshots, comps, and docs contain placeholders only—no
  production household data.

## 4. Durable design system

### 4.1 Color roles

All colors become semantic tokens in the shared design-token package and web
theme mapping. Components do not hard-code these values.

| Role | Initial value | Use |
| --- | --- | --- |
| Porcelain canvas | `#f7f9fc` | App background and quiet spatial separation |
| Surface | `#ffffff` | Tables, inspectors, sheets, cards, sticky chrome |
| Inset | `#f1f4f8` | Hover, grouped rows, secondary regions |
| Graphite | `#171a21` | Primary text and icons |
| Secondary graphite | `#667085` | Supporting text |
| Hairline | `#d9dee7` | Borders, dividers, grid lines |
| Cobalt | `#2563eb` | Actions, focus, selection, active controls |
| Cook / saffron | `#d97706` | Cook-domain wayfinding |
| Pantry / green | `#16845b` | Pantry-domain wayfinding |
| Plan / violet | `#6d5bd0` | Plan-domain wayfinding |
| House / cyan | `#147d92` | House-domain wayfinding |
| Finance / magenta | `#b5477c` | Finance-domain wayfinding |
| Positive | `#16845b` | Success/available state, paired with text or icon |
| Warning | `#b66a00` | Warning state, paired with text or icon |
| Destructive | `#c93636` | Errors and destructive actions only |

Domain color is expressive throughout, but it is structural rather than
confetti: navigation routes, page identity, entity marks, selected-context
spines, relationship paths, chart series, and compact categorical marks. Large
table backgrounds remain neutral. No domain uses destructive red.

### 4.2 Typography

- Use Inter Variable as the workhorse UI and heading face. Weight, size, and
  whitespace establish hierarchy; a decorative display face does not.
- Retain JetBrains Mono only for quantities, money, dates, shortcodes, and other
  values that benefit from tabular alignment.
- Remove Space Grotesk as a separate heading voice from the web PWA.
- Desktop table data is 12px with tabular numerals; ordinary UI body text is
  13–14px; long-form reading remains at least 14px with comfortable line height.
- Avoid uppercase/tracked micro-labels as the default. Use sentence case except
  for true codes and conventional abbreviations.

### 4.3 Geometry and depth

- Controls use a 6px radius; bounded panels use 8px; chips use 5px. Pills are
  reserved for inherently compact statuses or segmented choices.
- Use 1px hairlines and tonal separation. Remove signature 3px ink rules,
  square rubber-stamp geometry, and heavy entity spines.
- Resting application surfaces have no drop shadow. Popovers, menus, and modal
  overlays may use one restrained elevation token.
- Focus is a crisp cobalt outline/ring with sufficient contrast; never glow.

### 4.4 Density

| Surface | Desktop contract | Phone contract |
| --- | --- | --- |
| Read-heavy table | 28px rows, 32px header, 8px horizontal cell padding | Purpose-built list/card projection |
| Editable or multiline table | 32px rows; 40px only where content requires it | Full-width rows with 44px actions |
| Toolbar/control band | 32–36px controls | 44px targets and bottom sheets |
| Forms/details/dashboard | Normal 40px controls and 12–16px internal gaps | 44px controls and readable vertical rhythm |
| Inspector | 400px docked pane at wide desktop | Full detail route, not a squeezed pane |

- Keep the user's comfortable/compact/dense preference, but treat it as a table
  preference—not a global interface-density switch.
- A first visit to a canonical read-heavy table defaults to dense. Preserve and
  honor an existing stored table-density preference on subsequent visits.
- At 1440×900, a dense canonical list should expose roughly 24–28 useful rows.
- The table virtualizer's measured row height must exactly equal painted height.
- Horizontal scrolling remains valid inside wide desktop data grids. Normal
  pages and all phone surfaces must not overflow horizontally.

### 4.5 Motion

- Keyboard navigation, selection, sorting, filtering, inline editing, and other
  high-frequency operations respond immediately without animation.
- Inspector/sheet entrance, popovers, and toast transitions use purposeful
  120–180ms transform/opacity motion with spatially consistent origins.
- No rolling numbers, staggered rows, spring overshoot, blur-heavy morphs,
  perpetual shimmer, chart-drawing theater, tilt, or ambient animation.
- `prefers-reduced-motion` preserves state changes without unnecessary motion.

## 5. Signature entity-route interaction

Entity connections are a shared product capability, not a Product-only visual.

### Desktop

- Selecting a canonical table row opens a modeless 400px inspector at viewports
  at least 1280px wide. It preserves table scroll, selection, keyboard context,
  filters, and saved-view state.
- The inspector begins with identity and `Overview`, `Relations`, and `Activity`
  tabs. A compact horizontal path previews the primary relationship journey;
  the body continues it as a vertical spine through the relevant sections.
- Show direct relationships first. Collapse secondary branches behind explicit
  counts or disclosure controls. Never invent an edge because it would make the
  diagram prettier.
- Each station is a real link with entity identity, an accessible name, and
  enough context to disambiguate it. Selecting a station focuses its section;
  opening it navigates to the existing canonical detail route.
- Low-risk scalar fields may edit in place. Complex, destructive, or specialist
  workflows retain their dedicated surfaces.
- At 768–1279px, use the same inspector content in an explicit right sheet. It
  must not make the underlying table unusably narrow.

### Mobile

- Table rows use the existing semantic mobile projection and navigate to full
  detail pages. Do not dock or horizontally squeeze the desktop inspector.
- Render the relationship path as a horizontally scrollable route strip near
  the detail header and a stacked journey in the Relations section.
- Preserve contextual back navigation and scroll restoration.

### Status and color

- Domain color answers “what family is this?” Status answers “what condition is
  it in?” using text plus shape/icon. Never rely on hue alone.
- Dense tables may show small domain marks and compact statuses, but avoid a
  colored badge in every cell.
- Product routes belong to the Pantry/Inventory wayfinding family and use its
  green domain mark. This is navigation context, not Product status.
- The route strip and `Relations` journey index and recompose the existing
  specialist relationship sections. They do not introduce a third duplicate
  relationship ledger or a second source of truth.

## 6. Implementation targets and dependencies

All targets land in one branch, but each target is a bisectable commit group and
must pass its local gate before depending work proceeds. No partial visual-world
mixture is merged to the default branch.

Update the status and evidence cells in this table as work lands. `Complete`
means the named evidence exists; implementation without evidence remains
`In progress`.

| ID | Target | Depends on | Status | Completion evidence |
| --- | --- | --- | --- | --- |
| T0 | Governance and baselines | — | Complete | Rebased branch, approved references, relationship/calibration specs, and 18 source-state baselines are recorded in the evidence ledger |
| T1 | Tokens, fonts, and core primitives | T0 | Complete | Contrast checks, production build, focused tests, and desktop/mobile primitive gallery are recorded in the evidence ledger |
| T2 | Desktop/mobile shell and navigation | T1 | Complete | 224px/56px desktop rail, 48px command band, five truthful domain groups, preserved contextual mobile chrome/safe areas/keyboard behavior, focused tests, typecheck, and desktop/mobile screenshots are recorded in the evidence ledger |
| T3 | Products reference workbench | T1–T2 | Complete | Approved dense table, dock, Sheet, phone projection, one Product-owned relationship-route query, direct/derived provenance, and synthetic desktop/phone examples are recorded in the evidence ledger. |
| T4 | Canonical detail system | T1–T3 | Complete | Product detail reuses the same route model near the hero and in the full Relations journey, replaces the generic explorer without duplicate anchors, and preserves recategorized project-use history as read-only evidence. |
| T5 | All canonical lists and details | T3–T4 | Pending | Every listed entity migrated with mobile projection and honest actions |
| T6 | Today and normal-density surfaces | T1–T2 | Pending | Attention-first dashboard, readable modules, no KPI-card theater |
| T7 | Specialist workbenches | T1–T5 | Pending | Calendar, Gantt, spatial, reconciliation, scanner, and matrix contracts preserved |
| T8 | Peripheral web-PWA states | T1–T7 | Pending | Auth, OAuth, docs, offline, errors, loading, empty, print/export |
| T9 | Whole-PWA hardening and finish | T0–T8 | Pending | Detector, visual review, audit, tests, reviewer verdict, DESIGN.md and sidecar |

### T1 — Foundation

- Replace global palette, type, radius, elevation, spacing, focus, and motion
  tokens while preserving the shared design-token seam used outside `apps/web`.
- Rebuild Button, Input, Select, Checkbox, Badge, Card/Frame, Tabs, Menu,
  Popover, Dialog, Sheet, Tooltip, Table primitives, Skeleton, Toast, and form
  field states in Porcelain Transit.
- Add durable domain-wayfinding metadata and components instead of scattering
  route colors across navigation, rows, and charts.
- Keep current accessible Base UI/shadcn behaviors unless a documented defect
  requires a behavioral change.

### T2 — Shell

- Expanded desktop navigation groups Cook, Pantry, Plan, House, and Finance with
  stable colored route lines; collapsed mode is a 52–56px icon rail.
- Preserve the centralized route taxonomy, utility tier, command palette,
  mobile route descriptor, immersive-route behavior, virtual-keyboard handling,
  safe-area calculations, and five-tab phone navigation.
- Global chrome stays quiet; page identity, query/view, selection, and the
  current relationship route carry emphasis.

### T3–T5 — Canonical record surfaces

- Products is the non-negotiable reference implementation before other entity
  lists migrate. It must exercise wide columns, filters, display modes, saved
  layouts, density, selection, inline editing, bulk actions, empty/loading/error
  states, mobile cards, and docked inspection.
- Build the inspector as shared workbench composition around existing entity
  preview/detail contracts; do not replace `RTable` with a weaker grid.
- Product relationships use one Product-owned, bounded route projection. The
  renderer may be shared, but stock versus identity Location, purchase
  provenance, used-on versus purchased-for Projects, and derived Vendors remain
  structural domain facts rather than generic graph metadata.
- The Product inspector and canonical detail each mount exactly one non-blocking
  route query after Product identity is known. Loading and errors stay local to
  the route region; they do not gate the surrounding Product surface.
- Preserve virtualization, pinned columns, resize/reorder, spreadsheet cell
  selection, clipboard behavior, grouping, infinite loading, aggregate footers,
  row prefetch, and layout persistence.
- Migrate route families through shared primitives and compositions first, then
  route-local exceptions. Do not fork a private design system per domain.

### T6 — Today and ordinary pages

- Today leads with ranked household attention and next actions, then concise
  summaries and evidence. It is normal density.
- Metrics pair current value, comparison/context, consequence, and action. Do
  not fill the page with equal-weight KPI cards.
- Each chart answers one named question, exposes an accessible textual summary,
  and links to the underlying records.
- Phone Today uses a daily briefing rhythm: context, compact actionable summary,
  then deeper modules.

### T7 — Specialist surfaces

- Calendar retains month/week/day/agenda semantics, drag behavior, and mobile
  agenda rather than being forced into generic cards.
- Project board/timeline/Gantt retains split panes, zoom, dependencies, drag,
  and keyboard splitter behavior.
- Location arrange, pantry, photo-pass, inventory session, and scan retain
  spatial/immersive ownership and thumb-reachable capture actions.
- Recipe compare/export, collection assignment, statement reconciliation,
  recommendations, and ingredient workbench keep the information structure
  their task requires while inheriting global materials and controls.
- Background jobs and diagnostics may use dense operational rows, but remain
  light-mode Porcelain Transit—not Win32 or dark control-room styling.

## 7. Route coverage ledger

Each row must reach `implemented`, `verified`, and `reviewed`. A representative
route proves the shared system; every sibling still receives a rendered-state
check so shared coverage is not assumed blindly.

| Family | Representative and sibling routes | Status | Required proof |
| --- | --- | --- | --- |
| Today | `/` | Pending | Attention-first desktop and phone layouts; populated/empty/error |
| Products/inventory | `/products`, `/inventory`, new/bulk/session routes | Pending | Dense grid, docked inspector, mobile projection, capture and bulk workflows |
| Locations | `/locations`, detail, arrange, photo-pass, pantry view | Pending | Hierarchy, spatial work, DnD, inspector route, phone behavior |
| Planning | `/tasks`, `/projects`, project tools, `/calendar` | Pending | Table/detail, boards/Gantt/calendar, selection and drag states |
| Cooking | `/recipes`, cookbooks, ingredients, meals and all workbenches | Pending | Table/detail, long-form read/edit, matrices, import/export, shopping |
| Spending | `/expenses`, purchases, vendors, accounts, transactions, statement rows, contributions | Pending | Numeric alignment, reconciliation, totals, selection stats, no misleading spend |
| Collections/media | `/collections`, assignments, `/images`, wishes | Pending | Alternate views, assignment matrix, galleries, details |
| Search/intelligence | `/search`, `/ask`, recommendations, AI usage/smoke | Pending | Search-to-inspector continuity, streaming/loading/error, debug separation |
| Physical workflows | `/scan`, `/inventory/session`, photo pass | Pending | Camera permissions, manual fallback, keyboard, safe areas, landscape |
| Operations | `/activity`, `/problems`, background jobs, entities, MCP inspector, labels | Pending | Dense diagnostics, error/recovery, print labels |
| Account/settings | `/settings`, account views, connected apps | Pending | Forms, sections, disabled/success/error, narrow desktop and phone |
| Entry/peripheral | auth, OAuth consent, docs, offline, route pending/error/not-found | Pending | Complete light-mode states, accessible recovery, no old-world flash |
| Print/export | recipe export, labels, calendar feed-facing affordances | Pending | Print legibility and semantics; application chrome excluded intentionally |

## 8. State and input matrix

Every target is checked against the states it can realistically encounter:

- Populated: minimum, typical, and high-volume records.
- Empty: first-use and filtered-zero-result states with a valid next action.
- Loading: geometry-matched skeleton or explicit progress; no layout jump.
- Error/recovery: inline error, retry, permission limitation, offline behavior.
- Selection: row, cell range, multiple rows, bulk actions, inspector open/closed.
- Editing: default, focus, dirty, saving, success, validation error, disabled.
- Content: long names, missing images/relations, large numbers, negative money,
  dates, codes, and translated/expanded labels where applicable.
- Input: mouse, keyboard, touch, coarse pointer, virtual keyboard, reduced motion.
- Viewports: 320×568, 430×932, 844×390, 768–1024 intermediate, 1280, and
  1440×900. Wide tables may scroll internally; normal pages may not overflow.

## 9. Impeccable operating model

Do not invoke one vague “redesign everything” command and let independent agents
reinterpret the world. Every agent receives the direction contract, both
approved mocks, the target row, product invariants, relevant route list, required
states/viewports, and the validation owner.

Use Impeccable with behavioral surface targets:

1. The Products workbench uses the full approved new-world build process and is
   the reference surface.
2. Use `adapt` for the mobile shell and each materially different mobile route
   family after the desktop reference is stable.
3. Use `harden` on each migrated family for loading, empty, error, permissions,
   long content, offline behavior, and responsive edge cases.
4. Use `polish` once across the complete PWA after all families have migrated;
   do not polish one target while old-world siblings remain.
5. Run the detector once at finish when no hook is active. If the hook is
   enabled for implementation, do not add redundant manual detector loops.
6. Run the shipped finish reviewer with desktop/mobile screenshots, approved
   mocks, direction contract, and detector findings. Fix material findings in
   bounded batches and return for a verdict.
7. Run the read-only `audit` only after polish/fixes as the objective release
   scorecard.

## 10. Agent coordination

- One integration owner controls the direction contract, shared tokens,
  migration ledger, final joins, and all validation commands.
- Agent lanes are bounded by surface family with disjoint files. Shared shell,
  tokens, tables, inspector, and detail primitives have exclusive owners.
- No agent creates a new local palette, radius ladder, type scale, generic card
  family, or relationship metaphor. Needed additions go through the shared
  system owner.
- Every handoff reports target ID, changed surfaces, preserved invariants,
  tests/commands, duration, screenshots, unresolved findings, and ledger status.
- One agent owns each long validation command. Other agents continue useful
  work; the integration owner performs one bounded final join.
- Production data, migrations, and backend changes are out of scope unless a
  verified UI requirement cannot be served by current contracts and the user
  explicitly approves the expansion.

### Model routing

Use the cheapest model that owns the task safely; model choice follows the
task's ambiguity and blast radius, not the perceived importance of its route.

| Model and effort | Default role | Appropriate work | Do not assign |
| --- | --- | --- | --- |
| GPT-5.6 Terra, medium | Integration owner and implementation default | Bounded feature work, route-family migrations, responsive behavior, ordinary debugging, focused tests, evidence synthesis | Final independent review of its own work |
| GPT-5.6 Terra, high | Cross-cutting implementation owner | Shared primitives, multi-route refactors, RTable integration, shell/mobile interactions, complex regression diagnosis | Mechanical inventory or formatting work |
| GPT-5.6 Luna, low or medium | Cheap bounded worker | Route/state inventory, screenshot manifests, exact token replacement, repetitive sibling migration after the reference is stable, focused test execution, log distillation | New visual direction, shared architecture, ambiguous UX, conflict resolution, final verdicts |
| GPT-5.6 Sol, high | High-leverage designer/reviewer | T1–T3 architecture and the reference workbench, entity-route interaction review, material design ambiguities, adversarial midpoint review, final finish/audit verdict | Bulk sibling migration or routine test running |

The intended usage mix is roughly 65–75% Terra, 15–25% Luna, and 10–15% Sol
by agent turns. This is a routing budget, not a quality waiver.

- Luna receives exact files, invariants, screenshots, state/viewports, and a
  mechanical definition of done. If it discovers a missing design decision or
  needs to edit shared tokens, shell, RTable, inspector, or relationship
  semantics, it stops and returns the issue to Terra.
- Terra owns all merges and checks Luna's diff and evidence. Terra escalates a
  material visual-direction choice, cross-domain interaction conflict, or
  unresolved high-risk architecture decision to Sol.
- Sol is deliberately sparse: reference architecture before replication, one
  adversarial midpoint check after T3/T4, and the independent T9 finish review.
- Start at the listed reasoning effort. Raise effort only when the task has
  genuinely difficult multi-step reasoning or repeated uncertainty; do not use
  Max or Ultra by default.
- The final reviewer must not be the agent that implemented the reviewed
  surface, even when both use the same model family.

## 11. Verification gates

### Per-target gate

- Relevant focused unit/component tests pass.
- `pnpm typecheck` passes after cross-component or contract changes.
- Target renders at its representative desktop and phone viewport.
- Default, focus, selected, loading, empty, error, disabled, and long-content
  states are checked where applicable.
- No new console error, hydration mismatch, layout shift, unintended overflow,
  or inaccessible icon-only action.
- Diff uses shared tokens and primitives; no unexplained local visual system.

### Whole-app functional gate

- `pnpm check` and all affected test files pass.
- Existing full relevant CI/E2E gates pass on the exact final head.
- Table virtualization, density, sticky/pinned offsets, saved layouts, cell
  selection, clipboard, inline editing, grouping, and mobile projections retain
  focused regression coverage.
- Representative mobile E2E covers `/`, `/products`, a detail route,
  `/locations`, `/search`, `/scan`, and `/settings` at the named viewports.
- Auth, offline, not-found, route error, print/export, and immersive workflows
  receive direct smoke coverage.

### Visual and accessibility gate

- One batched desktop/mobile screenshot round compares the built Products
  workbench to both approved compositions. Fix material discrepancies together;
  confirm once.
- Every route-family representative is visually reviewed at desktop and phone;
  specialists also use the viewport that expresses their task.
- WCAG AA contrast, visible focus, table semantics, labels, status redundancy,
  screen-reader names, logical tab order, focus restoration, zoom, and 44px
  phone targets are verified.
- High-frequency interactions remain immediate; reduced motion is respected.

### Final independent gate

- Impeccable detector has no unresolved mechanical P0/P1 finding.
- Finish reviewer returns no open material finding and explicitly verifies the
  five direction-contract sections.
- Read-only Impeccable audit reaches at least **18/20**, no dimension below 3,
  no P0/P1 issues, and no unverified false-positive dismissal.
- The source diff contains no accidental formatter churn, debug output,
  temporary assets, obsolete old-world variants, or unowned TODOs.
- `DESIGN.md` and `.impeccable/design.json` describe the shipped world and are
  current with each other.
- The PR is non-draft, exact-head checks are green, and mergeability is verified.

## 12. Definition of done

The overhaul is done only when all statements below are true:

- [ ] T0–T9 are complete with evidence linked from the implementation ledger.
- [ ] Every route family has migrated; no ordinary app surface visibly mixes
      Warm-Paper Ledger and Porcelain Transit.
- [ ] The route-led shell, expressive domain colors, dense reference grid,
      docked inspector, and truthful entity routes are recognizable in the
      shipped Products surface.
- [ ] All canonical list routes retain their full table capabilities and have
      an intentional mobile projection.
- [ ] All canonical details expose relationships/activity without duplication
      and retain dedicated workflows for complex actions.
- [ ] Every specialist surface preserves its task model and adopts the shared
      material/control language.
- [ ] Phone surfaces remain native-feeling, safe-area aware, keyboard aware,
      free of accidental horizontal overflow, and usable at 320px.
- [ ] All realistic loading, empty, error, disabled, permission, offline,
      selection, editing, and long-content states are handled.
- [ ] Existing product invariants and data semantics remain true.
- [ ] Functional, visual, accessibility, detector, reviewer, audit, and exact
      CI gates in section 11 pass.
- [ ] Final screenshots, review verdict, audit score, design documents, and
      intentional exceptions are attached to the ready-for-review PR.

Passing tests alone is not done. A clean detector alone is not done. Migrating
the canonical routes while leaving peripheral or specialist surfaces in the old
world is not done. Completion is the entire route ledger green, the direction
contract visibly kept, and the final independent verdict closed.

## 13. Explicit non-goals

- Dark mode.
- Replatforming RTable, route architecture, Base UI, or the PWA shell behavior.
- Backend/domain/schema changes unrelated to a proven UI blocker.
- Copying Win32 styling, generic CRM records, synthetic stock automation, or
  invented dashboard metrics from the inspiration images.
- Decorative network graphs that obscure direct entity relationships.
- Global animation, global dense mode, or cardifying every record.
- A partial merge or prolonged mixed-world rollout.

## 14. Release strategy

Implementation occurs in one dedicated branch with target-level commits and
checkpoints. Rebase and validate at safe boundaries, but do not open the final
review until T0–T8 are complete. If a target exposes a foundational flaw, fix
the shared layer and re-verify its downstream targets rather than adding local
exceptions. Merge only after T9 and the complete definition of done pass.

## 15. Remaining reference packet

The existing inspiration set is sufficient to define the visual world. Do not
add another broad moodboard. Before T1, complete four Cubby-specific artifacts:

1. Baseline screenshots for `/`, `/products`, one canonical detail,
   `/locations`, `/scan`, and `/settings` at 1440×900, 430×932, and 320×568.
2. One annotated Products workbench calibration showing column rhythm, selected
   row, inspector open/closed, horizontal and vertical relationship paths,
   inline editing, bulk selection, and empty/loading/error variants.
3. One mobile calibration showing the Products list projection, full detail,
   route strip, stacked Relations journey, bottom navigation, virtual keyboard,
   and safe-area behavior.
4. An entity-route truth matrix naming each supported source/target pair,
   cardinality, primary/secondary priority, query owner, station label, empty
   behavior, and canonical click target. This is a product/data contract, not a
   decorative graph specification.

These artifacts close implementation ambiguity. Additional external references
are accepted only when one of them exposes a specific unresolved interaction or
specialist-workbench problem.

## 16. Working estimate

Current scope includes 115 route files, roughly 845 TSX files, and more than 500
test/spec files under `apps/web`. Shared primitives will migrate many surfaces
at once, but specialist workbenches and final visual verification remain
route-specific.

| Phase | Expected serial agent effort | Expected elapsed with bounded parallel lanes |
| --- | --- | --- |
| T0 calibration and baselines | 6–10 hours | 1–2 working days including review |
| T1–T2 foundations and shell | 16–26 hours | 2–4 working days |
| T3–T4 Products reference and detail system | 18–30 hours | 2–4 working days |
| T5–T8 route-family migration | 36–60 hours | 4–7 working days |
| T9 hardening, visual review, CI, and PR | 18–30 hours | 2–4 working days |

The planning range is **94–156 serial agent-hours**, or approximately **7–12
focused working days** with three bounded implementation lanes. Allow **2–3
calendar weeks** for user checkpoints, CI, review fixes, and integration joins.
This is an estimate, not a deadline.

The range assumes no schema migration, no backend redesign, current test
infrastructure remains healthy, and the Products reference surface is approved
without a direction reset. Relationship-data gaps, RTable regressions,
specialist surfaces that require new interaction architecture, or environmental
failures during authenticated visual QA move the work toward or beyond the high
end. Report forecast changes at T3, T5, and T8 rather than silently consuming
the contingency.
