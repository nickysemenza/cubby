---
target: Cubby authenticated web app full sweep
total_score: 30
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-08-19T00-11-23Z
slug: apps-web-src-app
---
Method: dual-agent (A: design_review · B: detector_browser); additional breadth lane: consistency_sweep

# Cubby Authenticated Web App — Full Impeccable Critique

Scope: the authenticated web app under `apps/web/src/app`, with representative live inspection across home, inventory, products, recipes, shopping, projects, expenses, and problems at desktop and phone viewports. The deterministic scan was narrowed from 503 non-test TSX files to 207 representative files, as required for a tree over 500 scannable files; the source consistency lane sampled every major workflow family and the shared shell, table, form, and navigation primitives.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|------:|-----------|
| 1 | Visibility of System Status | 3 | Strong task-specific feedback in recount and shopping, but generic skeletons make some route transitions feel anonymous. |
| 2 | Match System / Real World | 4 | Recount, pantry, recipe cost, project work, and spend use precise household language. |
| 3 | User Control and Freedom | 3 | Filters, view switches, and navigation exits are clear; mobile secondary navigation is a long directory. |
| 4 | Consistency and Standards | 3 | The shell and data tables are cohesive, but specialized surfaces bypass shared interaction and layout contracts. |
| 5 | Error Prevention | 3 | Core flows constrain many invalid actions; destructive and bulk edge cases were not all live-tested. |
| 6 | Recognition Rather Than Recall | 3 | Labels and breadcrumbs are strong, but locating one of roughly 40 secondary tools still requires a mental map. |
| 7 | Flexibility and Efficiency | 3 | Cmd-K, saved views, tables, bulk paths, and alternate renderers support experts; route and filter discovery remain costly. |
| 8 | Aesthetic and Minimalist Design | 3 | The visual system is disciplined, while Home and Projects still present too many equal-weight choices. |
| 9 | Error Recovery | 3 | Several flows preserve context and offer specific retry copy; recovery quality is not yet equally visible everywhere. |
| 10 | Help and Documentation | 2 | Domain copy is good, but high-consequence data/admin choices lack contextual why/how help. |
| **Total** | | **30/40** | **Good** |

## Design Specificity Verdict

**LLM assessment:** Strongly authored. Warm-Paper Ledger is visible in the shipped product: ruled paper surfaces, square controls, mono metadata, restrained ultramarine, dense record structures, and household-specific copy. An unrelated SaaS dashboard could not adopt this unchanged. The main weakness is not visual blandness; it is that a distinctive system is carrying too many competing destinations and controls at once.

**Deterministic scan:** The two bounded detector shards returned zero findings for the shared shell/home/table coverage and one `side-tab` warning for `apps/web/src/app/projects/charts/gantt/CubbyGantt.tsx:340`. That warning is a false positive: `border-e-2` marks the open end of an ongoing Gantt interval, a meaningful chart geometry allowed by the design contract. The detector missed the touch-target and navigation-load issues because they require product and responsive context, not pattern matching.

**Visual overlays:** No reliable overlay is available. The in-app browser exposed read-only evaluation but no supported mutable script injection surface, so the required preflight could not run; no overlay live server was started and no browser visibility claim is made.

## Overall Impression

Cubby already feels like a high-craft household instrument rather than a template. The biggest opportunity is to make the information architecture as calm and task-shaped as the visual design: surface what someone is trying to do now, then progressively reveal the full data model.

## What’s Working

1. **The visual language is genuinely product-specific.** Flat paper tones, ink rules, the three-voice type system, and data-dense table treatment consistently reinforce the household ledger metaphor.
2. **The responsive shell has real intent.** Desktop tables become mobile record cards; the phone bottom bar respects safe areas and 48px navigation targets; inventory keeps Recount prominent and thumb-reachable.
3. **Domain relationships are unusually legible.** Recipe cost and coverage, expense/vendor/project/product links, and project work plus spend communicate Cubby’s connected model without collapsing distinct concepts.

## Cognitive Load

The worst representative screens fail 4 of 8 checks: single focus, minimal choices, working-memory support, and progressive disclosure. Routine inventory and recipe browsing are lower-load; the pressure clusters in global navigation, Home, Projects, and flat filter choosers.

- Desktop navigation exposes roughly 44 leaves across eight groups.
- Mobile More exposes roughly 35 destinations plus Debug in one 70vh sheet.
- Expenses offers 14 Add-filter options; Recipes offers 10.
- Projects opens with four views, four status filters, three date ranges, saved views, and New Project competing for the first scan.

## Emotional Journey

The app opens with confidence and materiality. Inventory recount, shopping, and recipe flows feel reassuringly grounded in the physical household. The emotional valley is route selection—especially on phone—where “where did that tool go?” replaces the calm record-keeping feeling. Tailored completion and error copy usually restore confidence; anonymous skeleton blocks temporarily do not.

## Priority Issues

### [P1] Secondary navigation exposes the internal taxonomy before the household task

**Why it matters:** The expanded desktop rail and mobile More sheet give daily work, administrative tools, Data, and Dev nearly equal navigation weight. First-timers scan too much; interrupted mobile users must remember which data domain contains the task they wanted.

**Fix:** Keep daily household domains persistent, move Data/Dev behind a deliberate utility disclosure, make Mobile More task-based, and add recent destinations or in-sheet search. Preserve Cmd-K as the expert path.

**Files:** `apps/web/src/app/_components/navigation/nav-items.ts`, `apps/web/src/app/_components/navigation/authenticated-app-shell.tsx`, `apps/web/src/app/_components/navigation/bottom-nav-more-sheet.tsx`.

**Suggested command:** `$impeccable distill`

### [P1] The shared Button primitive violates the phone touch-target contract

**Why it matters:** `Button` defaults to 28px, with small and icon variants as low as 20–24px, and has no phone breakpoint policy. It is imported by 182 production TSX files, so safe mobile sizing depends on every call site remembering an override. This is a systemic motor-access and one-handed-use risk even though the bottom navigation and mobile cards handle targets correctly.

**Fix:** Encode responsive 40–44px phone targets in the primitive or introduce an explicit dense-desktop contract that cannot silently leak onto phone layouts. Verify dialogs, inline actions, and icon controls at 390px and 200% zoom.

**Files:** `apps/web/src/components/ui/button.tsx`; representative consumers include `apps/web/src/app/inventory/session/_components/MoveToDialog.tsx`, `apps/web/src/app/meals/shopping-list-page.tsx`, and `apps/web/src/app/projects/project-detail-page.tsx`.

**Suggested command:** `$impeccable adapt`

### [P2] Home and Projects prioritize control inventory over the next household decision

**Why it matters:** Home combines 17 entity links, activity, eight quick actions, signals, and insights. Projects presents view/status/date/saved-view controls before its “Needs attention” work. The content is useful, but too much begins at the same visual priority.

**Fix:** Organize Home around three or four intentions—cook, locate, plan, maintain—and move the entity index lower as “Browse records.” Make Projects lead with a compact Now/Needs attention state and group secondary filters behind one explicit Filter control with an active-scope summary.

**Files:** `apps/web/src/routes/index.tsx`, `apps/web/src/app/_components/home/QuickActionsCard.tsx`, `apps/web/src/app/projects/projects-dashboard.tsx`, `apps/web/src/app/projects/dashboard-filters.tsx`.

**Suggested command:** `$impeccable distill`

### [P2] Loading states lose the ledger’s accountable sense of progress

**Why it matters:** Generic large skeleton blocks briefly turn structured list/detail surfaces into anonymous card stacks. The shopping list’s “Adding up what you need…” proves task-specific framing is both possible and calmer.

**Fix:** Give route and dashboard loading states task-specific labels and skeleton geometry that matches ruled rows, spec plates, or the actual destination structure. Retain a stable page identity while data loads.

**Files:** `apps/web/src/components/route-pending.tsx`, `apps/web/src/components/feedback/loading-skeletons.tsx`, `apps/web/src/app/projects/projects-dashboard.tsx`.

**Suggested command:** `$impeccable harden`

### [P2] Specialized surfaces bypass otherwise-strong shared contracts

**Why it matters:** The Pantry View still applies negative gutter compensation from an older shell contract; Project Tools uses a shadow divider instead of an ink rule; Ingredient Enrichment hand-builds choice buttons without the shared focus, pressed-state, and touch policy. Each is small, but together they create future drift at the product’s edges.

**Fix:** Define a first-class full-bleed Page mode, use a real border/rule for the Project Tools sticky header, and route selection chips through one ledger-specific segmented/filter control.

**Files:** `apps/web/src/routes/_authenticated/pantry-view.tsx`, `apps/web/src/app/projects/tool-matrix-page.tsx`, `apps/web/src/app/ingredients/enrichment-workbench.tsx`.

**Suggested command:** `$impeccable polish`

## Persona Red Flags

**Alex (Power User):** Cmd-K, saved views, and dense tables are real accelerators, but the full rail and flat 10–14 option filter menus still demand scanning. Alex will expect recent scopes, keyboard-visible filter application, and a faster path to Data/Dev.

**Sam (Accessibility-Dependent):** Named navigation, tables, current-state semantics, and reduced-motion support are strong. The shared 20–28px Button variants and the long mobile More focus sequence are concrete blockers to comfortable motor and keyboard use; dense mono labels also need a bounded 200% zoom pass.

**Casey (Distracted Mobile User):** Recount and the bottom navigation work well one-handed. Casey’s failure mode appears when an interruption requires a secondary destination: More becomes a long directory, and undersized inline/dialog controls demand precision while attention is split.

## Minor Observations

- Rounded utility classes are mostly visual non-issues today because all radius tokens resolve to zero, but they encode the wrong contract and can reappear if the token changes.
- The unused context-menu primitive still carries dark, shadowed, zooming generic defaults. It is preventive cleanup, not current user-facing priority.
- Dense list/dashboard data remained in a loading state during some detector-lane captures; the design lane independently verified populated Projects, Expenses, and Recipes after waiting.

## Questions to Consider

- Should Cubby’s primary navigation describe current household intent or the complete data model?
- What would Home show if it optimized for “I have three minutes in the kitchen or workshop”?
- Is Dev part of daily household navigation, or should entering it feel deliberate?
