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
- Panels have a 16px radius; controls 8px; compact chips 7px. Nested surfaces follow concentric radii. Resting surfaces use tone and 1px structural rules, with shadow only for floating overlays.
- Images use a faint neutral outline. Give real record photos room in detail; use the declared entity symbol when there is no image. Never place an unrelated illustration in an empty hero.
- Motion explains state or space. High-frequency search, keyboard, table, and navigation actions respond immediately. Transitions name only changed properties and respect reduced motion.

## App frame

Wide web uses the existing 208px expanded or 56px collapsed rail, 48px command band, central work surface, and optional 400px modeless inspector at 1280px and wider. Intermediate widths use the inspector sheet. Phone uses contextual route navigation and complete detail routes. Preserve safe-area, virtual-keyboard, and history behavior.

The active rail item is an ink pill with a small citron mark. Group headings and small domain icons retain the five domain identities. Search, account, utility, and Settings remain reachable. Page headings use the editorial face; workbench controls, labels, and table headers remain functional sans text.

Today/Home uses only the existing task, problem, meal, activity, nutrition, inventory, and expense data. Put current work first, supporting household context second, and exploration behind disclosure. Summary cards must report real query values. No invented progress score, risk prediction, or AI panel.

## Generic records

Entity declarations own names, domains, images, fields, view choices, relations, sections, and action availability. Generated route shells and `GenericEntityList`/`GenericEntityDetail` render them. An entity-specific page may supply a declared slot or necessary query adapter; it does not introduce its own page chrome. The external USDA catalog remains an external-reference exception.

A complete record uses a clear human identity, optional true media, compact metadata, declared facts, direct relationships, supporting evidence, and actions the entity can actually perform. An inspector is a bounded preview of the loaded record and its direct context, never a second canonical detail page or a separate batch selection state. A row click inspects; a checkbox selects for batch work.

Specialist workflows such as photo review, import, calendar, Gantt, camera, reconciliation, and matrices keep their task-specific controls inside the shared frame. Preserve status wording and raw diagnostics where the product contract requires them.

RTable owns interactive record work: virtualization, pinned and resizable columns, saved layouts, filters, selection, clipboard, grouping, inline editing, and aggregate footers. Desktop data rows remain 32px by default. Every cell value gets the same 8px start padding; decorated cells render through `CellFrame`. A table view never becomes a stack of decorative cards on desktop. Phone rows use a semantic projection with a 44px minimum target.

## Interaction and accessibility

- One leading action per region; secondary actions are nearby and destructive actions are unmistakable. Primary controls use ink and light text. Status chips use text or icons as well as color.
- Search, filters, current row, batch selection, and inspector opening remain independent. Keep focus, hover, active, loading, empty, error, offline, and disabled states distinct.
- Keyboard and screen-reader users can reach the same navigation and actions. Focus is visible without layout shift. Phone targets are at least 44×44px. Text and panels reflow without horizontal page overflow.
- Validate the real desktop and phone flows after styling. Use synthetic records in tests, previews, screenshots, and engineering text.
