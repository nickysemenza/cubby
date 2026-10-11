---
name: Cubby Field Guide
summary: Warm, precise household records with sparse high-contrast signals.
sourceOfTruth: packages/design-tokens/tokens.json
appearance: light
---

# Cubby Field Guide

Cubby is a household field guide: a place to find a record, understand its evidence, and take the next real action. Warm paper-like surfaces invite reading; dense rows keep comparisons fast. Ink marks controls and current navigation. Citron marks focus or actionable attention sparingly. Domain colors identify where a record belongs. Positive, warning, and destructive colors describe condition. These roles never substitute for one another.

`packages/design-tokens/tokens.json` owns the shared palette and geometry. `pnpm generate` writes `brand.css` for web and MCP apps, and adaptive Apple color assets and Swift metrics. Edit the source, not those outputs. Web is light-only; Apple follows system light and dark appearances.

## Visual language

- Canvas `#F5F4ED`, surface `#FFFEFA`, inset `#EEEFE8`, ink `#1B211B`, secondary ink `#626960`, hairline `#D9DED2`.
- Interaction uses ink and a light label. Citron `#C9F45B` is a small signal dot, focus mark, or subtle selected-row wash. It is not a success, warning, or domain state.
- Five stable domain marks come from the entity declaration: Cook, Pantry, Plan, House, and Finance. Put them on navigation and record identity, not every card edge.
- Use a system serif or Georgia for page and record identity only. Body, labels, controls, and tables use Inter with system fallbacks; shortcodes use mono. Quantities and money use tabular numbers.
- Spacing comes from the shared token steps 4/8/12/12/16/16px (`packages/design-tokens/tokens.json`); the layout gap scale reads them, so web and native density move together. Desktop inputs, selects, and tab lists are 32px, matching the default button; menu items are 28px.
- Panels have a 16px radius; controls 8px; compact chips 7px. Nested surfaces follow concentric radii. Resting surfaces use tone and 1px structural rules, with shadow only for floating overlays.
  Web status, enum, category, and suggestion pills share `Pill` geometry. Saved values retain their semantic tint; suggestion mode uses a quiet dashed boundary with the same height and radius. Applying a suggestion shows pending feedback in that cell while the surrounding records remain readable.
- Images use a faint neutral outline. Give real record photos room in detail; use the declared entity symbol when there is no image. Never place an unrelated illustration in an empty hero.
- Motion explains state or space. High-frequency search, keyboard, table, and navigation actions respond immediately. Transitions name only changed properties and respect reduced motion.

## App frame

Wide web uses a compact 176px expanded or 40px collapsed rail, a 40px command band, central work surface, and optional 400px modeless inspector at 1280px and wider. Intermediate widths use the inspector sheet. Phone uses contextual route navigation and complete detail routes. Preserve safe-area, virtual-keyboard, and history behavior.

Chrome is dense: expanded rail routes are 26px rows with 13px labels, collapsed rail and footer controls are 28px, and roster counts are plain muted tabular numbers rather than chips. The active rail item is a quiet muted fill with ink text and a bold icon. Domain sections fold from their heading, and the fold persists per person; a domain dot on the heading and domain-colored icons in the collapsed rail retain the five domain identities. Search, account, utility, and Settings remain reachable. Page headings use the editorial face; workbench controls, labels, and table headers remain functional sans text.

Today/Home uses only the existing task, problem, meal, activity, nutrition, inventory, and expense data. Put current work first, supporting household context second, and exploration behind disclosure. Summary cards must report real query values. No invented progress score, risk prediction, or AI panel.

## Generic records

Entity declarations own names, domains, images, fields, view choices, relations, sections, and action availability. Generated route shells and `GenericEntityList`/`GenericEntityDetail` render them. An entity-specific page may supply a declared slot or necessary query adapter; it does not introduce its own page chrome. List workbenches use two stable rows: editorial identity and count beside primary actions, then search, active filter chips, a Filters disclosure, and a single manifest-driven view menu. Inactive filters stay inside the disclosure. Full filtered totals and suggestion sweep/review status share one compact wrapping strip directly above the records; errors and diagnostics remain visible with their controls. Phone query tools get their own full-width row and retain the filter/sort sheet. The external USDA catalog remains an external-reference exception.

A complete record uses a clear human identity, optional true media, compact metadata, declared facts, direct relationships, supporting evidence, and actions the entity can actually perform. An inspector is a bounded preview of the loaded record and its direct context, never a second canonical detail page or a separate batch selection state. A row click inspects; a checkbox selects for batch work.

Specialist workflows such as photo review, import, calendar, Gantt, camera, reconciliation, and matrices keep their task-specific controls inside the shared frame. Preserve status wording and raw diagnostics where the product contract requires them.

RTable owns interactive record work: virtualization, pinned and resizable columns, saved layouts, filters, selection, clipboard, grouping, inline editing, and aggregate footers. Desktop data rows remain 32px by default. Every cell value gets the same 8px start padding; decorated cells render through `CellFrame`. A table view never becomes a stack of decorative cards on desktop. Phone rows use a semantic projection with a 44px minimum target.

## Data visualization

Share the visual grammar, never the domain arithmetic. Statistical charts (ranked bars, donuts, spend trends) use `ui/charts/kit.tsx` (`RankedBarBreakdown`, `CategoryDonut`, `SpendTrend`) with `lib/nivo-theme.ts`, `ChartTooltip`, and `ChartEmpty`: one implementation of ranking, sizing, empty state, tooltip, keyboard-safe click, no-motion policy, and screen-reader summary. Keep `ChartTooltip` separate from absolute `VizTooltip`; Nivo owns tooltip placement.

- **Money stays server-owned.** Filtered SQL aggregates preserve `SUM(Expense.cost)`, credits, null-date treatment, and principal spend versus adjustments. Signed monthly and ranked net bars keep refunds below zero; positive-only donut arcs show a true-net center; the trade x cost-type matrix is the corrective detail for negative nets that stacked bars cannot show.
- **Specialized renderers stay specialized** when the semantics differ: dependency graphs (directed edges, worker layout, transitive reduction, cycle checks), Gantt (date geometry, drag, dependencies), calendar heatmaps, nutrition bars (uncertain ranges), the recipe cost treemap, the unit-mapping graph, the ingredient network, the entity reference graph (a schema overview, not record traversal), location hierarchy views, product-category donut (count and drill-navigation), task status board, and operational layouts (calendar grid, task board, project tree). They may reuse `viz-overlay.tsx` and `visualization-panel.tsx` frames and shared pivot helpers, not force-fit into the chart kit.
- **Graph workspace.** `/graph` and detail-page relationship maps use `relationships/graph-explorer.tsx` (React Flow, incremental worker placement, viewport culling, retained camera). Selection inspects without fetching; expansion is explicit; branches over 12 records start collapsed and reveal 12 at a time; one map holds at most 500 records and 1,000 connections; destination-path search keeps its server bounds. Relationship labels appear on hover, focus, or selection (always-visible labels dominated dense layout time). Keep a list alternative and connection evidence. Native Graph uses SwiftUI Canvas with card culling and no third-party package. Recipe and work dependency views keep their own layout and adapters above the generic relationship read.
- **Every chart** offers an accessible text alternative or summary, distinct loading, error, and empty states, and lazy-loads its renderer.

## Interaction and accessibility

- One leading action per region; secondary actions are nearby and destructive actions are unmistakable. Primary controls use ink and light text. Status chips use text or icons as well as color.
- Search, filters, current row, batch selection, and inspector opening remain independent. Keep focus, hover, active, loading, empty, error, offline, and disabled states distinct.
- Keyboard and screen-reader users can reach the same navigation and actions. Focus is visible without layout shift. Phone targets are at least 44×44px. Text and panels reflow without horizontal page overflow.
- Validate the real desktop and phone flows after styling. Use synthetic records in tests, previews, screenshots, and engineering text.
