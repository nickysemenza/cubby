---
name: Cubby Dense Utility
description: Dense light desktop workspaces with open sections and continuous record navigation.
---

# Design System: Cubby

## Overview

Cubby is a very dense, light desktop utility. Open content, compact contextual identity, aligned facts, and subtle gray section bands make household records easy to inspect and edit. Mobile web remains usable; native Swift apps own fieldwork. Web has no dark mode.

**Key Characteristics:**

- Dense desktop workspaces with visible information and actions.
- One continuous record column beside contents navigation.
- Restrained color, system typography, and flat structural separators.

The canonical token source is `packages/design-tokens/tokens.json` owns the palette, spacing, fonts, and separate web geometry. Generation writes `packages/design-tokens/brand.css`; `src/styles.css` binds the web theme. Change those sources rather than generated outputs. Native geometry and appearance remain independent.

## Colors

### Primary

Ink identifies primary controls and current navigation, with light labels. Citron is a sparse attention signal or selected-row wash; it never means success, warning, or domain identity.

### Secondary

Cook, Pantry, Plan, House, and Finance retain declaration-driven domain marks on navigation and record identity. Positive, warning, and destructive colors communicate condition with text or icons.

### Neutral

Canvas, white surface, gray inset, secondary ink, and hairline borders separate regions without decorating every record. Gray section bands use the shared muted surface.

## Typography

Use the platform system sans for identity, body, labels, controls, and tables. Hierarchy comes from size and weight. Detail titles use the shared title role; section headings are compact semibold text (13px). Shortcodes use system mono; quantities and money use tabular figures. Stacked table values use a primary line (13px type, 15px line height) and muted secondary line (11px type, 13px line height).

## Layout

The desktop shell has a collapsible navigation sidebar containing global search and create, with contextual identity and actions in the page itself. There is no global desktop command header. Preserve sidebar preferences, search, account, utilities, and Settings. Domain headings fold with persisted preferences; counts remain quiet tabular text. The modeless inspector is direct record context, with a sheet at intermediate widths and full detail navigation on phone. Preserve safe areas, virtual-keyboard behavior, and browser history.

Detail content is one scrolling column. Keep the sticky, independently scrolling ToC alongside wide content and the same hierarchy in phone “Jump to”; the switch follows available record width (800px). All empty fields and sections stay visible. A small identity thumbnail (48px) sits beside the title; the full gallery appears later in Images. Header actions wrap before squeezing identity. Lists retain compact workbench controls and horizontal table overflow rather than horizontal page overflow. Ownership evidence uses the shared RecordList in one content column.

Today/Home uses open dashboard frames and shared section bands. Current work leads, household context follows, and exploration stays behind disclosure. Summaries report existing query values; never invent progress scores, risk predictions, or AI panels.

## Elevation & Depth

Resting page and detail sections are open and flat, separated by tone and hairlines. Section headings use a subtle gray band rather than enclosing every section in a card. Floating overlays retain the shared overlay shadow; pinned table boundaries retain their functional edge treatment. Motion explains state, respects reduced motion, and stays immediate for frequent search, navigation, and table work. Do not add page-load or media entrance animation.

## Shapes

Web controls, chips and panels use their shared token radii. These web tokens are independent of native geometry. Inputs use a white surface and hairline border; nested surfaces keep concentric corners. Images use a faint neutral outline.

## Components

### Shared headings and actions

`Page` is the sole list/detail shell; `src/ui/layouts/page-hero.tsx` owns contextual headers. Detail identity is an open header with a structural bottom divider, thumbnail, wayfinding, readable title, quiet metadata, and inline stats. Keep Edit and the main workflow action visible; remaining review and destructive actions use accessible overflow. `SectionHeading` owns the wrapping gray heading band for details, forms, and home. `FormSection` uses it with sentence-case headings and retains explicit local disclosure behavior.

### Controls and suggestions

Default desktop buttons and inputs are compact (32px); small buttons and menu items are tighter (28px). Phone interactive targets retain at least 44×44px. Primary buttons use ink; outlined, secondary, ghost, and destructive variants retain distinct treatments. Focus uses a visible ring without layout shift; invalid and disabled states remain distinct.

Status, enum, category, and suggestion values share `Pill` geometry. Saved values retain semantic tint; suggestions have a quiet dashed boundary. Applying a suggestion shows cell-local pending feedback. Stored and live suggestions share the same surface contract. On detail pages and inspectors, a field suggestion shows the proposed value and Accept inline, on desktop and phone alike. Its field label and explanation control align with the proposal line in both collapsed and expanded Review states. Review expands beneath its owning row to expose confidence, runner-up, basis fields, evidence, Reject, and “Use a different value…”. Decision details contains provenance (model, time, Run, AI usage) and explains how a different value is recorded as a Miss. Table marks retain anchored popovers to preserve row geometry. Meaning never depends on a title attribute. `AiProposalCard` remains for prose proposals and uses the same confidence and Accept wording.

### Records, forms, and tables

Entity declarations own names, domains, images, fields, view choices, relations, sections, and action availability. Generated route shells and `GenericEntityList`/`GenericEntityDetail` render them. An entity-specific page may supply a declared slot or necessary query adapter; it does not introduce its own page chrome. List workbenches use one compact desktop row: system-sans identity and a quiet count, search and active filters, a Filters disclosure, a manifest-driven view menu, then actions. Controls wrap when their content needs room; the title never steals the search input’s usable width. Inactive filters stay inside the disclosure. Full filtered totals and suggestion sweep/review status share one compact wrapping strip directly above the records; errors and diagnostics remain visible with their controls. Phone identity and query tools get full-width rows; view and creation follow in the same reading and focus order. The filter/sort sheet remains. Filtered empty tables, phone rows, and cards share the same clear-filter recovery action; URL-only scopes retain their own chips. Card placeholders use a quiet entity symbol rather than a repeated decorative title. The external USDA catalog remains an external-reference exception.

A complete record uses a clear human identity, optional true media, compact metadata, declared facts, direct relationships, supporting evidence, and actions the entity can actually perform. Generated fact sections reuse the declaration’s edit groups, followed by remaining coverage and summaries; workflow slots follow these facts, while explicit sections and relation-first journals retain their declared intent. Fact groups and workflow sections use distinct headings so record navigation stays unambiguous. Detail titles and primary actions align on desktop; stats read inline rather than as separate metric blocks. Scalar facts use the shared `Ledger` facts layout: semantic label/value rows, quiet horizontal rules, aligned values, and a separate right-aligned action rail. Labels have a bounded readable column rather than taking half the record width. Provenance captions stay beside the value when space permits and wrap within that slot at narrow widths; they never push the info controls out of alignment. Read-only fact rows may be tighter than controls; phone links and actions keep their 44px target. Prose gets full-width space. Supporting metadata and stats use compact inline text rather than headline metric cards. Detail sections never split into columns: beside the table of contents, every section spans the full work surface in declaration order, and the full gallery stays in the declared Images section. Section actions wrap at narrow widths, and overflow-enabled sections remain unclipped by their plane. The header uses only a small identity thumbnail; gallery and image-management controls stay in the declared media section. High-frequency record navigation does not introduce media entrance or hover zoom animations. An inspector reuses the record’s declared fact groups, inline editors, suggestions, and contextual quality results in one continuous body. Its compact header has a small cover, wrapping identity, Open record, and full Edit; it does not reserve a large image card. Relations and Activity expand on demand and remain mounted after opening. Heavy workflow sections remain on the full record, linked from their contextual checks. Inspectors retain detail click-to-edit behavior when hosted by a table. Portaled scalar editors keep their controls within both viewport axes, including during resize, and scroll when their content exceeds the available height. A row click inspects; a checkbox selects for batch work.

Every applicable quality check has one visible result beside its declared field or owning section, including satisfied checks. Satisfied labels describe the recorded fact positively; missing data, defects, accepted exceptions, and neutral coverage retain distinct meanings. A compact quality summary links to the owning result. Explanations expand beneath their row; weights, caps, and score arithmetic remain on demand. Contributions describe checks, not invented per-field point deltas. Ordinary supported field values edit directly while full Edit remains available for coordinated changes, including declared editor exceptions. Inherited values display their effective value and retain an explicit way to return to inheritance. A conditionally hidden section cannot own an invisible quality result or a dead summary link; those checks need a visible fallback.

Full record details are one continuous, mounted page. Declared sections retain their Overview, Work and Evidence grouping; Relations and Activity follow, and formerly separate supporting views join Evidence. A wide work surface has a sticky, independently scrollable table of contents with every group and its indented subsections expanded. Below 800px of available record width, a compact “Jump to” menu exposes the same hierarchy. Links scroll and focus their stable section targets; scrolling updates the current entry without adding history. Explicit jumps retain URL fragments and browser Back/Forward. Section bodies start open; existing pagination and Show more controls remain. Empty sections stay in the page and outline with secondary titles, while create/actions keep normal contrast. List sections (relations, Connected records, photos, documents, sources) show their row count, 0 included, beside the heading and in the contents; other sections show no number, and an empty one is announced as Empty to assistive tech only. Contents entries are single-line and truncate, counts sit in a right-aligned tabular column, group labels are quiet uppercase, and the current entry is a left bar with foreground text. Relations holds one grouped Connected records section — each curated view with results shows its first three rows and a link to the complete view; views without results fold into one "No connections" line — then Relationships, which on a detail page is the graph explorer alone: the record's own relations, similar products and physical connections already appear elsewhere, so it never lists them again. Loading and failed reads never count as empty. Drafts stay mounted, and navigation responds immediately without entrance or smooth-scroll animation. Apple uses native Contents navigation; only the Run evidence pilot hosts the isolated Evidence surface. Related-record links return to native routes. The authentication and bridge contract lives in `apps/apple/DESIGN.md#run-evidence-pilot`.

The generic record editor lays fields out like the Ledger facts it edits: a quiet label column beside each control, stacked below a 26rem form width (the phone sheet). Identity fields lead; the declaration's edit sections order the rest. A field shows an AI suggestion only when it can act on it; the form's one status line and its breakdown report agreements, declines, and below-bar picks. A direct reference does not repeat "Linked to" under its picker. A date clears with its own ×; a separate clear button appears only for a named state such as "Date unknown". An update dialog's subtitle names the record being edited. A form taller than the dialog scrolls between a fixed header and footer.

Read-only detail lists use `ui/common/ledger.tsx`: `Ledger`, `LedgerRow`, and `LedgerCell` share container-aware columns, separators, trailing alignment, and compact row geometry. Facts preserve `dl`/`dt`/`dd`; record rows preserve list semantics. The two structural variants are facts and records, with composed leading, primary, secondary, trailing, actions, and expanded-detail slots. Links, editable values, choices, commands, raw diagnostics, and image sizes remain with their existing renderers. Rows with photos or form controls put their evidence below identity instead of squeezing controls into a leftover column; the photo spans those lines. Read-only record lists use `ui/common/record-list.tsx` on that geometry: 28px rows with hairline rules and a muted trailing fact (time, score meter, hop count, writer and time), quiet uppercase group headings with counts, a closing "+N more" row, one folded line for absent results, and loading, error and empty states that never read as each other. Its timeline variant draws Activity and entity timelines: a rail through action- or kind-colored dots, a heading per household day, and rows that print only their time. Connected records, relation evidence, similar products and recommendations, relationship branches, physical connections, graph list rows, sources, report rows, Run attention rows, and Activity all render through it; RTable and charts keep their own layouts.

Report `records` blocks of stage or log rows declare the `ledger` presentation, and ordered stages (a pipeline, run progress) declare `timeline`, which adds a rail from the first mark to the last: one aligned line per row with its `state` mark (its label stays readable), a plain title, one-line result and evidence, time, and commands. States have distinct marks: done, warning and failed are filled condition dots, running is an ink dot with a slow pulse (a still halo under reduced motion), skipped is a hollow ring, and not reached a faint point — never a dashed ring, which reads as loading. Machine codes in evidence read in mono. Clipped text keeps its full text as a tooltip; failures and warnings wrap in full. Row commands are quiet ghost buttons inside the row's height, links out carry an outbound arrow, and once any row has commands every row keeps that column so times share one right edge; on phone, commands sit under the text, aligned with it. A command that needs input opens beneath its own row rather than standing open. Timed rows that share a household day print only their time, with the day once in the block heading (or as the list's first line for an untitled block); rows spanning days print day and time; relative time is in the tooltip. Sources follow the same shape: the document and its shortcode, one line of the fields it supports (or the path it is related through), when it was seen, and its quotes behind a disclosure that starts open only for a lone source.

The dedicated Work queue inherits the list workbench and RTable. Record identity
leads, followed by Waiting for, reason, next action, source and kind. Waiting for
uses the current household member roster, Either for shared work and an explicit
Unresolved state with its explanation. Its filters and sort stack are URL state;
the shared infinite pager loads more work on scroll. Checkboxes select
record-backed work independently of the source record inspector. Copy codes
uses source shortcodes, deduplicating records with multiple work reasons;
aggregate Problems rows have no shortcode and are not selectable. Pending
Suggestions appear as one row per entity and field with their count, opening
the filtered AI Review list. Research and Email rows show one warning-toned
chip per failed check (destructive for defects), its message as tooltip and
screen-reader text, wrapping to two lines then "+N"; other rows keep reason
text. Vendor links its record, Amount uses the sign-toned currency cell, and
Date the plain-date cell. A record's own rows appear on its detail page and
inspector as a compact Work queue ledger — chips or reason, muted next action,
trailing Waiting for pill — absent when the record has no work. Column
controls are session-only, matching entity lists. Reason is enriched after
paging and remains unsortable; projected fields sort before paging. Record
links open the existing source record and its review controls. Run titles
link to the passive Problems overview until Run detail reads stop recovering
execution. Problems and Research saved views link into this projection without
creating assignments.

Specialist workflows such as photo review, import, calendar, Gantt, camera, reconciliation, and matrices keep their task-specific controls inside the shared frame. Preserve status wording and raw diagnostics where the product contract requires them.

RTable owns interactive record work: virtualization, pinned and resizable columns, in-session layouts, filters, selection, clipboard, grouping, inline editing, and aggregate footers. Desktop data rows retain 32px (`ROW_DENSITY`) so two-line values have readable separation. Every cell value gets the same 4px start padding; decorated cells render through `CellFrame`. A column is as narrow as its values: info, relation and resolution controls appear only on the hovered or focused row, over the cell's free edge, and reserve no width; a derived value reads muted, and suggestion marks stay visible. Quiet full-height column rules are fainter than the header boundary. Quality scores remain numerically sortable but their pills start at the same padding as other categorical values. Table thumbnail frames match the 32px row height and the image column reserves exactly that frame. The structural selection column is fixed at 32px; info controls use a 16px desktop footprint with a 10px glyph and preserve the coarse-pointer touch floor. Hover, inspected-current, and batch-selected states stay distinct, including pinned cells. The totals strip meets the table directly; a portaled empty toolbar must not leave a separator or spacer behind. The shared table fits columns to rendered headers, aggregate footers, and a bounded sample of current values, within their declared limits. Fits remain stable while inspecting or editing, manual resizing wins, and no column grows past its kind's cap to fit one long value, and spare width goes only to the record's identity, up to 240px ([column widths](../../docs/agents/web-ui-reference.md#column-widths)). Header labels use their short form and wrap to two lines inside the 32px header rather than widening their column; a count of one entity's records is headed by that entity's icon and "#", and a column of links to one entity carries that entity's icon in its header rather than on every row. A header's sort arrow takes width only while the column is sorted, and its source icon appears on hover or focus. A clipped single-line value spills over its neighbours at the same row height on hover or focus; codes (barcodes, order ids) keep their first and last four characters, and other long labels keep their tail. Entity links stack their compact name over muted context, or wrap a long name to two lines, and quality scores drop "/100". Dates and timestamps use one `DateDisplay`: full date/year and timestamp clock time followed by muted relative text outside tables; in tables, the day stacks over a compact distance ("Oct 13" / "3 min ago"; months use "3 mo ago", and another year leads that line, "’25 · 1y ago"), and chip lists wrap to two lines, then count the rest as "+N"; secondary context is type hierarchy, never parentheses. A table view never becomes a stack of decorative cards on desktop. Phone rows use a semantic projection with a 44px minimum target.

### Data visualization

Share the visual grammar, never the domain arithmetic. Statistical charts (ranked bars, donuts, spend trends) use `ui/charts/kit.tsx` (`RankedBarBreakdown`, `CategoryDonut`, `SpendTrend`) with `lib/nivo-theme.ts`, `ChartTooltip`, and `ChartEmpty`: one implementation of ranking, sizing, empty state, tooltip, keyboard-safe click, no-motion policy, and screen-reader summary. Keep `ChartTooltip` separate from absolute `VizTooltip`; Nivo owns tooltip placement.

- **Money stays server-owned.** Filtered SQL aggregates preserve `SUM(Expense.cost)`, credits, null-date treatment, and principal spend versus adjustments. Signed monthly and ranked net bars keep refunds below zero; positive-only donut arcs show a true-net center; the trade x cost-type matrix is the corrective detail for negative nets that stacked bars cannot show.
- **Specialized renderers stay specialized** when the semantics differ: dependency graphs (directed edges, worker layout, transitive reduction, cycle checks), Gantt (date geometry, drag, dependencies), calendar heatmaps, nutrition bars (uncertain ranges), the recipe cost treemap, the unit-mapping graph, the ingredient network, the entity reference graph (a schema overview, not record traversal), location hierarchy views, product-category donut (count and drill-navigation), task status board, and operational layouts (calendar grid, task board, project tree). They may reuse `viz-overlay.tsx` and `visualization-panel.tsx` frames and shared pivot helpers, not force-fit into the chart kit.
- **Graph workspace.** `/graph` and detail-page relationship maps use `relationships/graph-explorer.tsx` (React Flow, incremental worker placement, viewport culling, retained camera). Selection inspects without fetching; expansion is explicit; branches over 12 records start collapsed and reveal 12 at a time; one map holds at most 500 records and 1,000 connections; destination-path search keeps its server bounds. Relationship labels appear on hover, focus, or selection (always-visible labels dominated dense layout time). Keep a list alternative and connection evidence. Native Graph uses SwiftUI Canvas with card culling and no third-party package. Recipe and work dependency views keep their own layout and adapters above the generic relationship read.
- **Every chart** offers an accessible text alternative or summary, distinct loading, error, and empty states, and lazy-loads its renderer.

### Interaction and accessibility

- One leading action per region; secondary actions are nearby and destructive actions are unmistakable. Primary controls use ink and light text. Status chips use text or icons as well as color.
- Search, filters, current row, batch selection, and inspector opening remain independent. Keep focus, hover, active, loading, empty, error, offline, and disabled states distinct.
- Keyboard and screen-reader users can reach the same navigation and actions. Focus is visible without layout shift. Phone targets are at least 44×44px. Text and panels reflow without horizontal page overflow.
- Form labels connect to their input controls; placeholders provide examples and never substitute for the field's accessible name. Adjacent Tags and Collections inputs retain distinct names.
- Validate the real desktop and phone flows after styling. Use synthetic records in tests, previews, screenshots, and engineering text.

## Do's and Don'ts

### Do:

- **Do** keep all declared empty fields and sections visible, with usable actions.
- **Do** preserve continuous section navigation, mounted drafts, and URL history.
- **Do** use shared page, heading, ledger, table, and control primitives.
- **Do** keep Edit and the main workflow visible and overflow actions keyboard accessible.

### Don't:

- **Don't** restore the global desktop header, rounded detail title card, or duplicate Overview gallery.
- **Don't** split detail sections into desktop columns or substitute tabs for continuous content.
- **Don't** use decorative cards, invented metrics, or unrelated placeholder illustrations to fill space.
- **Don't** trade readable text, visible focus, or phone touch targets for density.
