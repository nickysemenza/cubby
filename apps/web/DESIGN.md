---
name: Cubby Dense Utility
description: Dense, flat, light desktop workspaces with a white working surface, ink controls, and record context beside every list.
---

# Design System: Cubby

## Overview

Cubby is a very dense, light desktop utility. A flat white working surface, a quiet #FAFAFA sidebar, 1px dividers, aligned facts and tinted status pills make household records easy to scan and edit. Mobile web remains usable; native Swift apps own fieldwork. Web has no dark mode; `cubby/no-dark-variant` rejects `dark:` utilities in web class strings, including primitives and ReUI.

**Key Characteristics:**

- Dense desktop workspaces with visible information and actions: 13px body, 28px navigation items, 32px table rows.
- Lists open records in a side inspector; the full record page leads with key numbers, what needs attention, and a merged activity timeline.
- Restrained color, Inter with Geist Mono figures, and flat 1px separators instead of floating cards.

The canonical token source is `packages/design-tokens/tokens.json` owns the palette, spacing, fonts, and separate web geometry. Generation writes `packages/design-tokens/brand.css`; `src/styles.css` binds the web theme and carries the web workspace palette (white surface, #333 ink, #737373 secondary ink, #EBEBEB hairline, #EDEDED current row, #0077E6 link), which overrides the shared light colors on web only. Change those sources rather than generated outputs. Native geometry and appearance remain independent.

## Colors

### Primary

Near-black ink (#202020) fills primary controls, with light labels. Blue (#0077E6) marks links and focus rings. Identity glyphs and enum choices may use the separate category-blue token; their labels and interaction affordances distinguish them from links. The current navigation item and the inspected table row use a flat grey (#EDEDED). Citron remains a sparse attention mark for needs-input steps; it never means success or warning.

### Secondary

Record identity glyphs use color. Identity and navigation use shared domain hues: ochre for Cook, teal for Pantry, purple for Plan, olive for House, and blue for Finance. Labels and active-route surfaces keep their existing ink and gray treatment; utility marks inherit the surrounding idle, hover and active ink. Positive, warning, destructive, info (in progress, running) and neutral-status (not started, none) communicate condition with text or icons, each with a matching quiet `*-surface` tint.

### Option roles

Every enum roster explicitly declares a role, a named color token, and a glyph pair for web and Apple. Field-level `optionRole`, `optionColor`, and `optionGlyph` provide contextual defaults; individual options override color or glyph where useful. Status tones supply their standard glyph when no override is declared. Categories may share a meaningful roster glyph and stable domain color. Unknown choices explicitly use neutral ink. The compiler resolves presentation once and rejects missing metadata; renderers never infer meaning from value spelling, color, or array order. Category chips use a quiet tint, foreground labels, and colored glyphs; status chips retain their condition surface and ink. Labels always remain visible. Named domain tokens own wayfinding hues on both clients; the category ramp is available for deliberate assignments.

### Action

Action color marks the outcome of a pending decision: create is blue, link/attach is neutral graphite and inset, change is muted ochre, and remove uses destructive. This third channel never substitutes for navigation identity or condition ("what state?"). Primary buttons stay ink; action color belongs on chips, glyphs and step marks.

### Neutral

White surface, #FAFAFA sidebar, #F5F5F5 hover and inset, secondary ink and #EBEBEB hairlines separate regions without decorating every record.

## Typography

Inter (self-hosted `@fontsource-variable/inter`) for identity, body, labels, controls, and tables; Geist Mono (`@fontsource-variable/geist-mono`) for shortcodes, money, counts and other tabular figures in tables, timelines and facts. Body text is 13px (`text-sm`), section titles 15px (`text-base`) or compact 13px semibold, page titles 20px semibold, captions 12px. Hierarchy comes from size and weight, with sentence-case labels (`text-xs text-muted-foreground font-medium`). `cubby/no-uppercase-utility` enforces sentence case; `cubby/no-arbitrary-font-size` requires the type scale (`text-3xs` 8px, `text-2xs` 10px, `text-xs` 12px, `text-sm` 13px, `text-base` 15px, then `text-lg` and `text-xl`). Key-number strips use 20px semibold Inter with tabular figures. Stacked table values use a primary line (13px type, 15px line height) and muted secondary line (12px type, 13px line height).

## Layout

The desktop shell has a collapsible navigation sidebar containing global search and create, with contextual identity and actions in the page itself. There is no global desktop command header. Preserve sidebar preferences, search, account, utilities, and Settings. Domain headings fold with persisted preferences; counts remain quiet tabular text. The modeless inspector is direct record context, with a sheet at intermediate widths and full detail navigation on phone. Preserve safe areas, virtual-keyboard behavior, and browser history.

A list row opens the record in the side inspector (J/K steps through rows, Enter opens the full page): a white panel with a 15px title and mono key, the declared key numbers as one inline line under the header (`KeyNumbers layout="inline"`), compact facts with "Add…" for empty editable fields, and hairline-topped sections; below 768px it is a full-screen sheet. The full detail page stacks: identity header, a key-numbers strip (up to four declared `detail.hero.stats` plus the declared monthly spend chart), then a small sticky contents index beside one full-width content column: the first fields section (the record's identity facts, in two columns), Needs you (suggestions, quality findings and declared workflow prompts in one block that reserves its space while loading), the merged Activity timeline, then the declared sections. Activity groups entries by household day with a date and calendar-day relative-age gutter; “Show older” continues the existing cursor pages. The index lists groups as quiet bold labels with their sections indented on a hairline guide, each led by its icon (a relation by its target entity's icon) and its row count; the current section follows the reading position, and a jump marks its destination. Jumps remain immediate for reduced-motion users. Empty sections read muted. Below the two-column width the index becomes the phone “Jump to”. Key numbers show only declared stats the detail read carries. Monthly spend readouts use portalled tooltips so strip clipping cannot hide edge values. The chart has one tab stop; arrow keys, Home and End move between labelled months without a second hidden copy of the data. All empty fields stay visible: an empty editable stored field reads as a quiet "Add…" that opens the editor, and a derived one as a dash. Fact sections at least 40rem wide reflow into two columns; narrow fact lists (the inspector) give labels a fixed share and start every value on one left edge, with no dotted leaders. Needs you collapses when nothing in it needs attention and shows a count of visible attention rows. Field info icons appear on row hover or focus; a row with a quality finding keeps a visible marker. A small identity thumbnail (48px) sits beside the title; the full gallery appears later in Images. Header actions wrap before squeezing identity. Lists retain compact workbench controls and horizontal table overflow rather than horizontal page overflow. Ownership evidence uses the shared RecordList in one content column.

Settings and long analytical workspaces (expense analytics, portfolio analytics, and cash flow) use `IndexedSections`: a continuous column with sticky contents navigation at 800px available width and phone “Jump to”, stable section hashes that preserve search parameters, and mounted drafts. Embedded expense analytics stays inside the record’s existing contents navigation. Keep controls and summaries above the indexed body. Settings groups connections, mail and purchases, household access, and maintenance; connection diagnostics remain behind an explicit disclosure. Use tabs for distinct workflows rather than sections of the same page.

Today/Home titles itself with the household day and keeps Log meal and New task in the page header. A key-numbers strip (Tasks due, Needs you, Spent this month, Pantry on hand) leads, then Today and Needs you side by side as ruled 32px rows, then What changed grouped by household day with the day in a quiet gutter. From 1280px a right rail holds Meals, Money (recorded spend by month), Today’s nutrition, Pantry by location and Your views; below it the rail follows the main column. Records and Insights stay behind disclosure. Every figure is an existing query value; never invent pace, progress scores, risk predictions, or AI panels.

## Elevation & Depth

Resting page and detail sections are open and flat, separated by 1px hairlines and whitespace. Section headings are plain semibold text; no gray bands and no cards around resting content. Rounded, shadowed containers are reserved for things that float: the inspector, popovers, menus and dialogs. Floating primitives share `popoverElevationClassName` and `--brand-elevation-popover`; the responsive schema inspector uses the same token only while floating. `cubby/no-shadow-utility` rejects sized and arbitrary shadow utilities; these floating surfaces carry explicit lint exceptions. Resting surfaces and table boundaries use flat hairlines. Motion explains state, respects reduced motion, and stays immediate for frequent search, navigation, and table work. Do not add page-load or media entrance animation.

## Shapes

Web controls use 8px radii (30px tall buttons, 28px navigation items), chips 6px (20px tall), floating panels 12px. These web tokens are independent of native geometry. Inputs use a white surface and hairline border; nested surfaces keep concentric corners. Images use a faint neutral outline. `cubby/no-large-radius` rejects `rounded-xl`, `rounded-2xl`, `rounded-3xl` and their directional variants; use `rounded-md` or `rounded-lg`. `cubby/no-hand-rolled-panel` requires `Panel` for any rounded, bordered box; its `.oxlintrc.json` exemptions cover primitives, pickers, overlays, ReUI, the date-picker input, text and code blocks, `EmptyState`, and the two Home files awaiting the Home rewrite.

## Components

### Component sources and boundaries

`components.json` configures the shadcn Base UI/Mira family; local primitives
are maintained in `src/ui/primitives`. Base UI owns accessible interaction,
while Cubby owns their styling and composition. The remaining copied ReUI
surface is the event calendar; its exact source and license live in
[`src/ui/reui/SOURCE.md`](src/ui/reui/SOURCE.md). Filters and file upload are
Cubby-owned. Prefer existing shared components before importing registry items.

Different jobs justify different public components, not duplicate engines or
styling. Share lower-level behavior and tokens where the contracts agree:

- Date and date-range selection use DayPicker; event scheduling uses the ReUI calendar's
  range geometry, event placement and drag/drop. They are separate workflows.
- `Picker` owns values; Command and DropdownMenu own navigation/actions.
  Switch owns a boolean and Tabs own content panels. The
  [value-control contract](docs/web-ui.md) owns mode selection and binding.
- Interactive lists, static tables, matrices, record evidence and detail facts
  retain their distinct structures; [table contracts](docs/web-ui-reference.md#tables)
  own the choice of shared renderer.
- `Overlay` owns ordinary dialogs and workspace panels: placement, independent
  body scrolling, explicit primary/native-form actions, summary and raw diagnostics.
  Phone writes use a full-height sheet with Cancel/title/primary in its header;
  desktop actions stay in the fixed footer. Pending-action spinners are decorative;
  the action text supplies the button's accessible name and stays mounted while
  pending, including pagination. Mark each spinner decorative even when a caller
  sometimes supplies an explicit `aria-label`. Form owners pass the same form id to
  `primary.form` and `FormWrapper`, hide the form's own actions, and forward
  `onSubmittingChange` into the overlay's `pending` state. This covers resolver
  validation, custom commits, suggestion receipts and completion callbacks.
  Cancel, close, Escape and backdrop dismissal are blocked throughout a primary
  write; controlled success closure still restores focus. Independent row actions
  remain dismissible. Command search, the full photo viewer, desktop calendar popover and modeless/graph
  inspectors retain their specialized presentations; AlertDialog retains explicit
  confirmation semantics. Dialog and Sheet remain low-level Base UI surfaces.
  `cubby/no-ordinary-dialog-bypass` rejects their composition imports (including
  aliases, namespaces, re-exports and static dynamic loads); `DialogTrigger`
  stays available to ordinary callers. Exact-path lint exceptions cover only
  Overlay itself, the Dialog/Sheet implementations, cmdk's command presentation,
  the full photo viewer, the relationship graph inspector, the modeless entity
  preview, and the shared `SidePanel`'s
  below-xl sheet (the docked record panel keeps its J/K row stepping and resize
  handle when it becomes a sheet). New exceptions require a
  specialized interaction reason here, not a directory-wide exemption.
  Long phone action labels wrap within their share of the header; it grows
  beyond its 52px minimum rather than clipping controls. Raw overlay diagnostics
  wrap unbroken values and scroll within 30dvh so forms retain space.
- Chart, relationship-map and specialized layout engines follow the
  [visualization contracts](#data-visualization); a common frame does not require
  one renderer.
- `Section` owns headings, actions, body spacing and optional disclosure across
  pages, dashboards and forms. Its disclosure defers children until open;
  `keepMounted` is explicit when a caller accepts eager work. Drafts that must
  survive closing belong in the form state owner, not a disclosure child.
- Badge owns named semantic tones. EnumPill picks the declared role's renderer:
  `StatusValue` (glyph, tone surface, tone ink) for states and `CategoryValue`
  (quiet matching tint, foreground label, glyph in the option color) for kinds; booleans without
  a roster use `BooleanValue`. Pill owns shared geometry, compact icon spacing
  and suggestion treatment.
- `SidePanel` (`ui/overlays/side-panel.tsx`) is the one docked record panel —
  the entity inspector and specialist detail panels such as AI Decisions: a
  sticky header with eyebrow, title and code, banded sections, a J/K/Esc
  footer, and a resize handle that sets `--side-panel-width` for the session.
- Apple keeps native SwiftUI controls and platform geometry; shared semantic
  tokens and declarations do not require a shared rendering implementation.

Dashboard frames use `Section` with the same flat heading row and body
inset as page and form regions. Heading actions are siblings of disclosure
triggers, so using an action never opens or closes its section. Canvas text uses the shared system font token;
web typography needs no bundled font faces.

### Page building blocks

One look per job: a page composes these instead of styling its own header, figure strip, box or empty message. Each has layouts on `/design` (`#page-header` through `#facts`), and `cubby/no-hand-rolled-panel` keeps rounded bordered boxes inside `Panel`.

- **`PageHeader`** (`ui/layout/page-header.tsx`) — every page's identity row. `stacked` puts a breadcrumb over the title and a fact line under it (record details, Home); `inline` keeps facts beside the title (list and tool pages). One status chip, actions that wrap before squeezing the title.
- **`KeyNumbers`** (`ui/common/key-numbers.tsx`) — headline figures. `strip` is a hairline-ruled row of label, value and context that reflows on narrow widths (detail pages, dashboards); `inline` is one muted line of bold values (the inspector, compact summaries). `onSelect` and `active` make a figure a drill-through filter.
- **`Section`** (`ui/layout/section.tsx`) — every resting region: a 15px semibold title with optional mono count, quiet actions and a takeaway caption over a hairline. `compact` for nested regions; `empty` mutes a region with nothing in it; `disclosure` folds it.
- **`Panel`** (`ui/layout/panel.tsx`) — the only bordered box. `tone` is required: `default` (hairline) for focused flows and repeated items, `muted` (fill, no border) for supporting material set apart inside a flow (previews, diagnostics), `warning` (tinted fill) for a callout that needs attention. Optional `title`, `caption`, quiet `actions` beside the title, edge-to-edge `media` above it, and `flush` for tables.
- **`EmptyState`** (`ui/feedback/empty-state.tsx`) — `inline` is a dashed slot inside a section with an optional link; `page` centres an icon, message and one action for a whole empty list or search.
- **`Toolbar`** (`ui/layout/toolbar.tsx`) — a labelled `toolbar` with `start` controls, `end` search and a `below` row for applied filters; search wraps onto its own line on phones.
- **`Disclosure`** (`ui/layout/disclosure.tsx`) — a quiet chevron summary with `meta` and an `aside` that stays on the summary row; bodies mount when opened unless `keepMounted`.
- **`Facts`** (`ui/common/facts.tsx`) — labelled values; see [Records, forms, and tables](#records-forms-and-tables).

### Custom-built signature components

These are Cubby's own components, designed and built here rather than adopted from a component library; the headless pieces under them (Base UI popups and focus, TanStack Table state) carry no visual design. Each has a live, synthetic showcase on `/design`, which is also the home for any new component demo:

- **`Picker`** (`ui/combobox/picker.tsx`) with `PickerField`, `PickerVisual` and `PickerOption` — every value choice: choose, search and segmented modes, single and multiple values, records with pictures and options with glyphs (`/design#picker`).
- **Records ledger and timeline** — `RecordsBlockView` (`entity/entity-detail/records-block.tsx`), `Ledger`/`LedgerRow`/`LedgerCell` (`ui/common/ledger.tsx`), and `RecordList` with its `Record*` parts (`ui/common/record-list.tsx`) (`/design#records`).
- **`RTable`** (`entity/table/table.tsx`), reached through `ListWorkbench` (`/design#rtable`).
  Its synthetic showcase compares plain and visual cells alongside editing,
  range copy/paste, and grouping. `CellBar` and `CellSparkline`
  (`ui/data-table/visuals/cell-visual.tsx`) supplement
  readable values with explicit fixed scales; missing samples break the trend.
  Stock targets and price histories are illustrative, page-local evidence.
  The showcase's presentation toggle stays page-local; saved-view presentation
  preferences are not connected.
  Production Project lists declare an own-task completion bar, with "No tasks"
  for an empty denominator. Deadline cell treatment follows
  [the shared date rules](docs/web-ui.md).
  Run lists show recorded current-phase work, purpose-specific items per minute
  when supported, and the latest progress/heartbeat time. Unknown totals omit
  the bar; paused and stale samples do not advertise a live rate.
- **`IndexedSections`** (`ui/data-table/indexed-sections.tsx`) — the continuous grouped page with its sticky contents index and Jump to menu; record details and `/design` both render through it (`/design#indexed-sections`).
- **`LocationTree`**, `DateDisplay`, `EnumPill`, `GapChipCluster` and `FilterBar` (`/design#location-tree`, `/design#values`).

The showcase is a curated reference using fixed synthetic fixtures and real
module interactions, without fixture editors. Working compositions cover
command actions and responsive workflow retry (`/design#action-workflows`),
long action labels and scrollable raw diagnostics, inline/cell suggestion review (`/design#suggestion-review`), owner-held form
state and shared Section disclosure (`/design#section-compositions`), and quality
states with signed/empty chart data (`/design#quality-charts`). Source labels
name current modules rather than historical locations. Debug JSON remains
read-only and expandable through `ui/text/json-renderer.tsx`.

### Shared headings and actions

`Page` is the sole list/detail shell; `PageHeader` (`ui/layout/page-header.tsx`) draws every identity row and `src/entity/page/entity-page-header.tsx` composes it for records and lists. Detail identity is an open header with a structural bottom divider, thumbnail, wayfinding, readable title, quiet metadata, and inline stats. Keep Edit and the main workflow action visible; remaining review and destructive actions use accessible overflow. `Section` owns the flat heading row (strong text over a hairline rule) for details, forms, dashboards and Home, with sentence-case headings, explicit heading levels and a shared disclosure trigger. `Panel` is the bordered box, kept for focused flows (sign-in, consent, triage stops), repeated list items and callouts.

### Controls and suggestions

Default desktop buttons and inputs are compact (32px); small buttons and menu items are tighter (28px). Phone interactive targets retain at least 44×44px. Primary buttons use ink; outlined, secondary, ghost, and destructive variants retain distinct treatments. Focus uses a visible ring without layout shift; invalid and disabled states remain distinct.

Every value choice is one `Picker`, dense like a menu, never like a form card. Record popups grow to 36rem or the field's width, bounded by the available viewport; fixed choices retain the field width (growing to at most 16rem for narrow fields). Lists have 4px padding and no row gap. Rows have a minimum height of 28px desktop and 44px on phones: one fixed 20px leading mark (the record's picture, else the option's tinted glyph, else a swatch — never two), a flexible wrapping name, aligned secondary/status and right-aligned mono data columns, and a reserved checkmark column. Missing metadata leaves its column empty. Enum subtitles retain the declared label and semantic color through `EnumPill`; figures are tinted only for a real condition. On phones metadata wraps beneath the name. Search-match and disabled reasons remain beneath identity; trees use quiet sentence-case group headings and indent. Opening a populated search picker reveals the selected row without reordering the roster, scrolling the page, moving input focus, or repeatedly resetting manual scrolling. Typing searches the full candidate scope. The closed field repeats the selected row's mark and, when it has room, its first chip. Segmented mode is the same picker inline for a handful of view modes or formats.

Status, enum, category, and suggestion values share `Pill` geometry. Saved status values retain their tone surface and category values use quiet matching tints; suggestions have a quiet dashed boundary. Applying a suggestion shows cell-local pending feedback. Stored and live suggestions share the same surface contract. Empty suggestible cells keep a compact visible status, with details available on hover, keyboard focus, or activation: checking, skipped for missing evidence or candidates, no suitable match, below the review threshold, rejected, or failed. Missing evaluation history is explicitly unknown; it does not establish that evaluation never ran. Populated fields hide routine settled status and retain actionable proposals and failures. On detail pages and inspectors, a field suggestion shows the proposed value and Accept inline, on desktop and phone alike. Its field label and explanation control align with the proposal line in both collapsed and expanded Review states. Review expands beneath its owning row to expose confidence, runner-up, basis fields, evidence, Reject, and “Use a different value…”. Decision details contains provenance (model, time, Run, AI usage) and explains how a different value is recorded as a Miss. Table marks retain anchored popovers to preserve row geometry. Meaning never depends on a title attribute. `AiProposalCard` remains for prose proposals and uses the same confidence and Accept wording.

### Records, forms, and tables

Pending Suggestion counts sit beside a record's identity as quiet, focusable
badges that open the shared record review in a popover. Record details host
that review as a section. Automatic decisions have their own RecordList and detail section, with
family and review-status pickers in the list’s compact control row, with a quiet count beside the page title, affected-record links, a readable decision and
Wrong. Unverified legacy applications say so beneath the decision; raw payloads
stay in an explicit Technical evidence disclosure. Family declarations choose
the actions and evidence; clients do not create another family review screen.

Entity declarations own names, domains, images, fields, view choices, relations, sections, and action availability. Generated route shells and `GenericEntityList`/`GenericEntityDetail` render them. An entity-specific page may supply a declared slot or necessary query adapter; it does not introduce its own page chrome. List workbenches use one compact desktop row: system-sans identity and a quiet count, search and active filters, a Filters disclosure, a manifest-driven view menu, then actions. Controls wrap when their content needs room; the title never steals the search input’s usable width. Inactive filters stay inside the disclosure. Full filtered totals and suggestion sweep/review status share one compact wrapping strip directly above the records; errors and diagnostics remain visible with their controls. Phone identity and query tools get full-width rows; view and creation follow in the same reading and focus order. The filter/sort sheet remains. Filtered empty tables, phone rows, and cards share the same clear-filter recovery action. Every declared filter, column-hosted or not, lives in the Filters disclosure; a deep-linked scope shows as an active chip like any other filter. Card placeholders use a quiet entity symbol rather than a repeated decorative title. The external USDA catalog remains an external-reference exception.

A complete record uses a clear human identity, optional true media, compact metadata, declared facts, direct relationships, supporting evidence, and actions the entity can actually perform. Generated fact sections reuse the declaration’s edit groups, followed by remaining coverage and summaries; workflow slots follow these facts, while explicit sections and relation-first journals retain their declared intent. Fact groups and workflow sections use distinct headings so record navigation stays unambiguous. Detail titles and primary actions align on desktop; stats read inline rather than as separate metric blocks. Scalar facts use the shared `Ledger` facts layout: semantic label/value rows, quiet horizontal rules, aligned values, and a separate right-aligned action rail. Labels have a bounded readable column rather than taking half the record width. Provenance captions stay beside the value when space permits and wrap within that slot at narrow widths; they never push the info controls out of alignment. Read-only fact rows may be tighter than controls; phone links and actions keep their 44px target. Prose gets full-width space. Supporting metadata and stats use compact inline text rather than headline metric cards. Detail sections never split into columns: beside the table of contents, every section spans the full work surface in declaration order, and the full gallery stays in the declared Images section. Section actions wrap at narrow widths, and overflow-enabled sections remain unclipped by their plane. The header uses only a small identity thumbnail; gallery and image-management controls stay in the declared media section. High-frequency record navigation does not introduce media entrance or hover zoom animations. An inspector reuses the record’s declared fact groups, inline editors, suggestions, and contextual quality results in one continuous body. Its compact header has a small cover, wrapping identity, Open record, and full Edit; it does not reserve a large image card. Relations and Activity expand on demand and remain mounted after opening. Heavy workflow sections remain on the full record, linked from their contextual checks. Inspectors retain detail click-to-edit behavior when hosted by a table. Portaled scalar editors keep their controls within both viewport axes, including during resize, and scroll when their content exceeds the available height. A row click inspects; a checkbox selects for batch work.

Every applicable quality check has one visible result beside its declared field or owning section, including satisfied checks. Satisfied labels describe the recorded fact positively; missing data, defects, accepted exceptions, and neutral coverage retain distinct meanings. A compact quality summary links to the owning result. Explanations expand beneath their row; weights, caps, and score arithmetic remain on demand. Contributions describe checks, not invented per-field point deltas. Ordinary supported field values edit directly while full Edit remains available for coordinated changes, including declared editor exceptions. Inherited values display their effective value and retain an explicit way to return to inheritance. A conditionally hidden section cannot own an invisible quality result or a dead summary link; those checks need a visible fallback.

Full record details are one continuous, mounted page. Declared sections retain their Overview, Work and Evidence grouping; Relations and Activity follow, and formerly separate supporting views join Evidence. A wide work surface has a sticky, independently scrollable table of contents with every group and its indented subsections expanded. Below 800px of available record width, a compact “Jump to” menu exposes the same hierarchy. Links scroll and focus their stable section targets; scrolling updates the current entry without adding history. Explicit jumps retain URL fragments and browser Back/Forward. Section bodies start open; existing pagination and Show more controls remain. Empty sections stay in the page and outline with secondary titles, while create/actions keep normal contrast. List sections (relations, Connected records, photos, documents, sources) show their row count, 0 included, beside the heading and in the contents; other sections show no number, and an empty one is announced as Empty to assistive tech only. Contents entries are single-line and truncate, counts sit in a right-aligned tabular column, group labels use quiet sentence case, and the current entry is a left bar with foreground text. Relations holds one grouped Connected records section — each curated view with results shows its first three rows and a link to the complete view; views without results fold into one "No connections" line — then Relationships, which on a detail page is the graph explorer alone: the record's own relations, similar products and physical connections already appear elsewhere, so it never lists them again. Loading and failed reads never count as empty. Drafts stay mounted, and navigation responds immediately without entrance or smooth-scroll animation. Apple uses native Contents navigation; Run evidence and Connections use isolated hosted sheets. Related-record links return to native routes. The authentication and bridge contract lives in `apps/apple/DESIGN.md#hosted-workspaces`.

The generic record editor lays fields out like the Ledger facts it edits: a quiet label column beside each control, stacked below a 26rem form width (the phone sheet). Identity fields lead; the declaration's edit sections order the rest. A field shows an AI suggestion only when it can act on it; the form's one status line and its breakdown report agreements, declines, and below-bar picks. A direct reference does not repeat "Linked to" under its picker. A date clears with its own ×; a separate clear button appears only for a named state such as "Date unknown". An update dialog's subtitle names the record being edited. A form taller than the dialog scrolls between a fixed header and footer.

Read-only detail lists use `ui/common/ledger.tsx`: `Ledger`, `LedgerRow`, and `LedgerCell` share container-aware columns, separators, trailing alignment, and compact row geometry. Facts preserve `dl`/`dt`/`dd`; record rows preserve list semantics. The two structural variants are facts and records, with composed leading, primary, secondary, trailing, actions, and expanded-detail slots. Links, editable values, choices, commands, raw diagnostics, and image sizes remain with their existing renderers. Rows with photos or form controls put their evidence below identity instead of squeezing controls into a leftover column; the photo spans those lines. Labelled values are facts, never "·"-joined prose: `Facts` (`ui/common/facts.tsx`) writes a muted label and a foreground value, `layout="inline"` in rows and evidence and `layout="list"` for detail and inspector properties (headline figures use `KeyNumbers`), and a list whose rows share facts declares columns so each value sits under one quiet header label, wrapping to inline labels below 40rem; values wrap rather than clip. Read-only record lists use `ui/common/record-list.tsx` on that geometry: 28px rows with hairline rules and a muted trailing fact (time, score meter, hop count, writer and time), quiet sentence-case group headings with counts, a closing "+N more" row, one folded line for absent results, and loading, error and empty states that never read as each other. Its timeline variant draws Activity and entity timelines: a rail through action- or kind-colored dots, a heading per household day, and rows that print only their time. Connected records, relation evidence, similar products and recommendations, relationship branches, physical connections, graph list rows, sources, report rows, Run attention rows, and Activity all render through it; RTable and charts keep their own layouts.

Every report `records` block draws as one ledger, and ordered stages (a pipeline, run progress) declare `timeline`, which adds a rail from the first mark to the last: one aligned line per row with its `state` mark or thumbnail, its title (the chip of the record it opens, when it opens one), any state other than done spelled out beside it, its badges, its result and evidence lines one under another, its figure and time, and commands. Each quiet line clips on a wide row with its whole text as a tooltip. A block's own commands follow its rows, as on native. The server folds a run of the same timed event into one row with a `×N` figure and each event's time and evidence in its detail, and the AI usage report groups calls by operation, model, transport and outcome under Charged, Standard and Savings figures, because a sweep repeats one call hundreds of times. A badge or line every row would repeat (a log's source, a call's transport) is a muted line, not a chip. States have distinct marks: done, warning and failed are filled condition dots, running is an ink dot with a slow pulse (a still halo under reduced motion), skipped is a hollow ring, and not reached a faint point — never a dashed ring, which reads as loading. Machine codes in evidence read in mono. Failures and warnings wrap in full. Row commands are quiet ghost buttons inside the row's height, links out carry an outbound arrow, and once any row has commands every row keeps that column so times share one right edge; on phone, commands sit under the text, aligned with it. A command that needs input opens beneath its own row rather than standing open. Timed rows that share a household day print only their time, with the day once in the block heading (or as the list's first line for an untitled block); rows spanning days print day and time; relative time is in the tooltip. Sources follow the same shape: the document and its shortcode, one line of the fields it supports (or the path it is related through), when it was seen, and its citations (field, variant, quote, when and by whom) behind a disclosure that starts open only for a lone source. A state mark sits on its row's first line.

Run phase progress shows known processed/total counts, percentage, remaining
units, and a qualified rate/ETA. Unknown totals use a moving ink segment;
reduced motion keeps that segment visible and stationary. Progress owns its
activity animation separately from intentionally static loading skeletons.

The dedicated Work queue is a triage list, not a table. Line tabs (All,
Review, Research, Waiting, Automatic) carry each view's server total in mono
and a J/K · Enter hint; the view, filters and sort are URL state, and the
shared infinite pager loads more work on scroll. Each decision row reads its
type and record name (with vendor and sign-toned amount, and the Waiting for
pill, on the right), then a muted line with the reason and next action beside
the rule's details and one Review or Open button. A gap row's reason is its
gap messages as sentences. Waiting for uses the current household member
roster, Either for shared work and an explicit Unresolved state with its
explanation. Clicking a row inspects its record (J/K step, Enter opens the
full page); pending Suggestions open the Suggestions page scoped to their
family or record. Checkboxes select record-backed work independently of the
inspector, and a floating dark selection bar offers only the queue's bulk
actions: Copy codes (source shortcodes, deduplicating records with multiple
work reasons) and Select all N matching. Aggregate Problems rows have no
shortcode and are not selectable. A record's own rows appear on its detail
page and inspector as a compact Work queue ledger — gap chips or reason,
muted next action, trailing Waiting for pill — absent when the record has no
work. Reason is enriched after paging and remains unsortable; projected
fields sort before paging. Run titles link to the passive Problems overview
until Run detail reads stop recovering execution. Problems and Research saved
views link into this projection without creating assignments.

The Suggestions workspace has Pending, Automatic decisions and Automatic rules
line tabs. Pending counts only actionable proposals; automatic history is an
optional audit with feedback, separate from pausing future automation. Statement
review expansions use Source, Proposed result (Applied result in history), and
Evidence as flat, ruled sections. The result includes transaction and spending
relationships, existing/new vendor and alias, purchaser basis, explicit vendor
account state and recorded-spend effect. Draft changes replan on the server;
loading and raw errors never present the previous draft as the current result.
Provider category keeps one label with each named provider's observed value;
conflicting observations remain separate. Statement Rows browses all imported
observations by default and links into scoped Suggestions for reconciliation.
The family choice stays in a bounded horizontal scroll strip, and scope chips
sit beneath it. Impact chips lead with one caution-first label and count the
remaining labels as "+N".

The Problems overview is one `IndexedSections` page grouped Needs you,
Fixes automatically, Coverage & cues and Upkeep. Its headline reads inline
"N need you · M fix automatically · K coverage gaps", each figure the sum of
its group's contents counts, and the Fix button shows M. A section's count is
the true size of its detector keys, never its sampled rows. Rows render through
`RecordList`: each row leads with its record's cover (or the entity mark), its
name links the record with a hover preview, and its facts — including other
records it names, as chips — align into the section's columns, derived from the
rows' labels. A row with its own severity keeps a dot; a row whose title names
something other than its route's record keeps a plain title and an Open
button. Messages wrap, actions are ghost buttons on one line; a sampled section closes with "+N more" into its exact list,
and auto-fix sections preview three rows. "How it works" folds each query's
assembly; a stale input is one warning line in the section it affects. Checks
with nothing to report fold into one "N checks passing" line after the groups.

Specialist workflows such as photo review, import, calendar, Gantt, camera, reconciliation, and matrices keep their task-specific controls inside the shared frame. Preserve status wording and raw diagnostics where the product contract requires them.

Photo review keeps a Label media slot even without a label photo: show Missing,
or Unreadable when analysis completed without readable text. Pending/failed/skipped
analysis stays explicit. Do not repeat absence beside every form field; use
Not shown on label only where a field comparison needs it. Evidence compares
the current saved Product: comparison marks and name-derived values use saved
fields too, independently of pending Product changes. New-product comparisons
use the creation draft. Show loading and failed saved-record reads explicitly;
never substitute pending proposal values when saved evidence is unavailable. Label
identifier types and issuers; an unclassified printed code is evidence, never
an inferred model or external identifier based on which field is empty. Size
and colour comparisons derived from the Product name say so. Show selected
changes first, disclose unchanged fields, and name set/replace/clear outcomes.
Confirmation summarizes selected detail changes independently of adding photos.
Proposed text and expanded applied activity share the inline word diff: green
insertions, red struck-through deletions, and explicit before/after text for
assistive technology. Full review diffs wrap; compact incidental diffs truncate.

RTable owns interactive record work: virtualization, pinned and resizable columns, in-session layouts, filters, selection, clipboard, grouping, inline editing, and aggregate footers. Desktop data rows retain 32px (`ROW_DENSITY`) so two-line values have readable separation. Every cell value gets the same 4px start padding; decorated cells render through `CellFrame`. A column is as narrow as its values: info, relation and resolution controls appear only on the hovered or focused row, over the cell's free edge, and reserve no width; a derived value reads muted, and suggestion marks stay visible. Columns have no vertical rules; only horizontal row hairlines and the pinned-column boundary divide the grid. Amounts in cells read in mono so a column of money aligns by digit. Quality scores remain numerically sortable but their pills start at the same padding as other categorical values. Table thumbnail frames match the 32px row height and the image column reserves exactly that frame. The structural selection column is fixed at 32px; info controls use a 16px desktop footprint with a 10px glyph and preserve the coarse-pointer touch floor. Hover, inspected-current, and batch-selected states stay distinct, including pinned cells. The totals strip meets the table directly; a portaled empty toolbar must not leave a separator or spacer behind. The shared table fits columns to rendered headers, aggregate footers, and a bounded sample of current values, within their declared limits. Fits remain stable while inspecting or editing, manual resizing wins, and no column grows past its kind's cap to fit one long value, and spare width goes only to the record's identity, up to 240px ([column widths](docs/web-ui-reference.md#column-widths)). Header labels use their short form on one line, fitting their column up to 160px and truncating past it with the full label in the title; a count of one entity's records is headed by that entity's icon and "#", and a column of links to one entity carries that entity's icon in its header rather than on every row. A header's sort arrow takes width only while the column is sorted, and its source icon appears on hover or focus. A clipped single-line value spills over its neighbours at the same row height on hover or focus; codes (barcodes, order ids) keep their first and last four characters, and other long labels keep their tail. Entity links stack their compact name over muted context, or wrap a long name to two lines, and quality scores drop "/100". Quality scores stay visible even at 100; complete records use muted numerals and retain their spoken status. An entity that declares `list.titleSubtitle` gets its record caption as a muted second line under the identity, inside the same 32px row. Dates and timestamps use one `DateDisplay`: full date/year and timestamp clock time followed by muted relative text outside tables; in tables, the day stacks over a compact distance ("Oct 13" / "3 min ago"; months use "3 mo ago", and another year leads that line, "’25 · 1y ago"), and chip lists wrap to two lines, then count the rest as "+N"; secondary context is type hierarchy, never parentheses. A table view never becomes a stack of decorative cards on desktop. Phone rows use a semantic projection with a 44px minimum target.

Each header leads with a quiet kind glyph (date, money, number, choice, person, toggle; text, the default, carries none) and opens a column menu from a caret on hover or focus (the caret holds its own slot, leading on numeric columns, so it never covers the label or sort target): sort ascending or descending, a live inline filter checklist (sharing the filter bar's draft, facets and URL state), Group by when the entity declares that grouping, pin, and hide. A filtered column shows an info-toned funnel beside its label. A column empty in every loaded row collapses to a 40px strip showing its glyph, label in the tooltip, unless the person sized, sorted, filtered or pinned it. Its menu keeps the same hover caret and stays mounted as rows and visible columns change, so a live filter edit can continue through an empty result. Embedded relation tables take their declared section grouping and sort (Project Tasks group by Status, latest due first), omit the column that points back at the record they sit on, and may regroup from a header for the visit.

Tables expose a Group control only for declared grouping choices. Declared problem views tint their counts from the existing problem classification. Active-filter chips are 20px with 6px corners and 11px text; toolbar search and buttons are 30px. Filter sections use sentence-case labels, typed rows, inline boolean choices and a live count. Whole-table empty states use `EmptyState` page geometry. Initial desktop loading draws ten 32px skeleton rows under the actual columns. A footer appears when a visible money column has numeric loaded values; it uses the server aggregate when present, otherwise labels loaded-row totals explicitly. The floating selection bar keeps query controls visible, totals each visible loaded money column separately, and renders only the list's existing bulk actions.

### Data visualization

Location browsing keeps a compact navigation outline beside a continuous,
scrollable gallery of the full filtered hierarchy. Sidebar names jump to mounted
location sections; scrolling the gallery highlights and reveals the current
location in the outline, like the entity-detail contents index. Outline disclosure
never hides gallery sections. Gallery indentation is 12px per level, capped at
36px so deep trees retain content width. Inventory contents are disclosed per
location on demand. Open record and inventory links retain their record
destinations; breadcrumbs jump through the hierarchy. Phones keep the same
continuous gallery with collapsible location navigation.
The page shell owns creation; the browser toolbar does not repeat New.
Search and type/contents filters retain matching locations and their ancestor
paths, rather than revealing every descendant of a matching name; Clear filters
remains available with no results. Clearing filters restores manual expansion.
`TreeOutline` owns shared keyboard traversal, focus, disclosure and geometry;
`LocationOutline` supplies location identity and inventory semantics. Desktop
outline rows are 28px with 12px indentation per level and quiet numeric rollups;
phone and coarse-pointer actions retain a 44px minimum target. Roots initially
expand one level. Collapsed branches unmount their descendants, and frequent
tree navigation and disclosure have no movement animation.

Share the visual grammar, never the domain arithmetic. Statistical charts (ranked bars, donuts, spend trends) use `ui/charts/kit.tsx` (`RankedBarBreakdown`, `CategoryDonut`, `SpendTrend`) with `lib/nivo-theme.ts`, `ChartTooltip`, and `Visualization`: one implementation of ranking, sizing, empty state, tooltip, keyboard-safe click, no-motion policy, and screen-reader summary. Keep `ChartTooltip` separate from absolute `VizTooltip`; Nivo owns tooltip placement.

- **Money stays server-owned.** Filtered SQL aggregates preserve `SUM(Expense.cost)`, credits, null-date treatment, and principal spend versus adjustments. Signed monthly and ranked net bars keep refunds below zero; positive-only donut arcs show a true-net center; the trade x cost-type matrix is the corrective detail for negative nets that stacked bars cannot show.
- **Money reads to the cent.** Totals, summary strips, tooltips, matrix cells and screen-reader summaries format with cents so they reconcile against statements. Only axis ticks and labels painted inside a bar or arc may round to whole dollars.
- **Specialized renderers stay specialized** when the semantics differ: dependency graphs (directed edges, worker layout, transitive reduction, cycle checks), Gantt (date geometry, drag, dependencies), calendar heatmaps, nutrition bars (uncertain ranges), the recipe cost treemap, the unit-mapping graph, the ingredient network, the entity reference graph (a schema overview, not record traversal), location hierarchy views, product-category donut (count and drill-navigation), task status board, and operational layouts (calendar grid, task board, project tree). They may reuse `viz-overlay.tsx` and `visualization.tsx` presentation and shared pivot helpers, not force-fit into the chart kit.
- **Graph workspace.** `/connections`, `/graph`, and detail-page relationship maps share `relationships/graph-explorer.tsx` (React Flow, incremental worker placement, viewport culling, retained camera). Compact 224px map nodes carry a 40px cover, identity, and two curated facts; selection opens the full eight-fact inspector. The inspector and minimap start closed. Many-record relationships are counted branch buttons, and only direct singleton relationships open automatically. Descendants and siblings stay hidden until their branch is expanded; Show wider network explicitly reveals the loaded branches, including siblings. Loading a record never grants visible expansion intent. The entity's preview roster owns the facts; canonical selected-field list readers supply prices, recorded spend, quantities, and progress in batches by entity kind. Never invent a card-specific money calculation. The focus sits at the center, relationship branches radiate around it, and descendants fan outward in their parent's direction. Existing positions and camera stay put during expansion. Fit focus frames the first ring at a minimum 85% zoom; manual zoom stops at 85%, and Collapse all returns to relationship summaries. Maps start at one link; deeper traversal and distant path search remain explicit. Fit map, a collapsible inspector, and a linked paths list support different densities. Direction arrows and relationship labels retain canonical edge ownership even when a path traverses backward. Selection inspects loaded facts; branch expansion is explicit; pages reveal 12 records at a time; one map holds at most 500 records and 1,000 connections. The depth picker supports one through four links without increasing those budgets. Destination-path search keeps its server bounds. `/connections` without a record offers a starting-record picker; existing view-specific URLs retain their connected-records table and offer the map. Recipe and work dependency views keep their own layout and adapters above the generic relationship read.
- **Connection context.** Detail headers and the connections workspace surface up to four populated curated connected views, with linked targets and expandable witnessed paths. A shared vendor or location is not purchase intent. Product purchase-project context follows the product's own Expenses to their assigned Projects; a mixed order must not assign a sibling line's Project to this Product. Multiple targets remain visible with the total count. Suggestions stay in their explicit review surface in the inspector and never become recorded graph edges before acceptance. Swift uses this same workspace directly on the global graph route and in a scoped full-screen presentation from record details; the old Swift graph and connection-review UI are removed.
- **Visualization presentation** uses `ui/visualizations/visualization.tsx`: explicit loading, empty, error and ready states. Initial errors show raw diagnostics and Retry. A ready state may carry an inline refresh error; the renderer stays mounted through failure and retry so camera, focus and selection survive. `visualizationState` reads only the current query's data/error; neither it nor the frame caches data. Query keys own entity/record/filter/date/order/page scope, and owners must not use previous-scope placeholder data. The component that owns the query (including expense analytics, entity timelines and location trees) supplies lifecycle state and Retry; a ready-only outer frame cannot substitute for query error handling. Hydration-gated owners keep loading visible until hydration completes. Optional portfolio Analytics retains its enabled query and lazy renderer gate.
- **Every chart** offers an accessible text alternative or summary, distinct loading, error, and empty states, and lazy-loads its renderer.

### Interaction and accessibility

- One leading action per region; secondary actions are nearby and destructive actions are unmistakable. Primary controls use ink and light text. Status chips use text or icons as well as color.
- Search, filters, current row, batch selection, and inspector opening remain independent. Keep focus, hover, active, loading, empty, error, offline, and disabled states distinct.
- Keyboard and screen-reader users can reach the same navigation and actions. Focus is visible without layout shift. Phone targets are at least 44×44px. Text and panels reflow without horizontal page overflow.
- Form labels connect to their input controls; placeholders provide examples and never substitute for the field's accessible name. Adjacent Tags and Collections inputs retain distinct names.
- Validate the real desktop and phone flows after styling. Use synthetic records in tests, previews, screenshots, and engineering text.

## Do's and Don'ts

### Do:

- **Do** keep all declared empty fields visible; editable ones offer a quiet "Add…" that opens the editor.
- **Do** preserve continuous section navigation, mounted drafts, and URL history.
- **Do** use shared page, heading, ledger, table, and control primitives.
- **Do** keep Edit and the main workflow visible and overflow actions keyboard accessible.

### Don't:

- **Don't** restore the global desktop header, rounded detail title card, or duplicate Overview gallery.
- **Don't** substitute tabs for continuous record content, or wrap resting sections in cards.
- **Don't** make table rows taller than 32px; a second line under a title is opt-in per table where it carries real context.
- **Don't** use decorative cards, invented metrics, or unrelated placeholder illustrations to fill space.
- **Don't** trade readable text, visible focus, or phone touch targets for density.

### Decision steps

`DecisionSteps` is the interactive RecordList timeline, using RecordRow expanded detail and actions. Done uses a filled positive dot, blocked a faint point, not needed a hollow ring, and needs input a citron attention mark, never warning. Answered rows keep their summary inline and a quiet change disclosure: 28px on desktop, 44px phone targets. Only the open body is visible; hidden bodies stay mounted to preserve drafts and suggestion receipts. Opening a body moves focus into it. Optional 112px evidence media spans the rows on desktop and precedes them on phone. Callers supply steps and bodies; the component owns only disclosure.
