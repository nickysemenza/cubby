---
name: Cubby Dense Utility
description: Very dense, flat, light desktop workspaces with a white working surface, ink controls, and record context beside every list.
---

# Design System: Cubby

## Overview

Cubby is a very dense, light desktop utility, because vertical space is the scarce resource on a desktop record tool and width is not. A flat white working surface, a quiet #FAFAFA sidebar, 1px dividers, aligned facts and tinted status pills make household records easy to scan and edit. Mobile web remains usable; native Swift apps own fieldwork. Web has no dark mode; `cubby/no-dark-variant` rejects `dark:` utilities in web class strings, including primitives and ReUI.

**Key Characteristics:**

- Dense desktop workspaces with visible information and actions: 12px body, 22px navigation items, 24px table rows.
- Density belongs to fine-pointer desktops. Below 768px, on coarse pointers and in hosted native workspaces (`:root[data-hosted-workspace]`), the base scale stays: 13px body, 28px navigation, 32px rows, 44px phone targets, and those hosted workspaces keep their shipped colors and radii. One block in `src/styles.css` owns the switch; components consume `--table-row-height`, `--table-header-height`, `--nav-row-height`, `--pill-height`, `--record-pill-height`, `--fact-row-height`, `--control-height*`, `--input-height` and `--section-gap` rather than fixed heights. `ROW_DENSITY.rowHeight` reads the same variable.
- Lists open records in a side inspector; the full record page leads with key numbers, what needs attention, and a merged activity timeline.
- Restrained color, Inter with Geist Mono figures, and flat 1px separators instead of floating cards.

The canonical token source is `packages/design-tokens/tokens.json` owns the palette, spacing, fonts, and separate web geometry. Generation writes `packages/design-tokens/brand.css`; `src/styles.css` binds the web theme and carries the web workspace palette (white surface, #262626 ink, #737373 secondary ink, #E5E5E5 hairline, #EDEDED current row, #0077E6 link), which overrides the shared light colors on web only. Change those sources rather than generated outputs. Native geometry and appearance remain independent.

## Colors

### Primary

Near-black ink (#111111) fills primary controls, with light labels. Blue (#0077E6) marks links and focus rings. Identity glyphs and enum choices may use the separate category-blue token; their labels and interaction affordances distinguish them from links. Current domain navigation rows use a quiet domain tint; current utility navigation and the inspected table row use a flat grey (#EDEDED). Citron remains a sparse attention mark for needs-input steps and one cell of the ink shelf-grid logo; it never means success or warning.

### Secondary

Record identity glyphs use color. Identity and navigation use seven shared domain hues: purple for Plan, ochre for Cook, teal for Pantry, olive for Garden, terracotta for House, rose for Purchases, and blue for Finance. Sidebar glyphs retain the section hue when idle and active; current rows use its 13% surface tint with strong ink labels. Section headers carry a 6px rounded square in that hue. Top, Records and Dev glyphs use muted ink and their current rows stay gray. Positive, warning, destructive, info (in progress, running) and neutral-status (not started, none) communicate condition with text or icons, each with a matching quiet `*-surface` tint.

### Option roles

Every enum roster explicitly declares a role, a named color token, and a glyph pair for web and Apple. Field-level `optionRole`, `optionColor`, and `optionGlyph` provide contextual defaults; individual options override color or glyph where useful. Status tones supply their standard glyph when no override is declared. Categories may share a meaningful roster glyph and stable domain color. Unknown choices explicitly use neutral ink. The compiler resolves presentation once and rejects missing metadata; renderers never infer meaning from value spelling, color, or array order. Category chips use a quiet tint, foreground labels, and colored glyphs; status chips retain their condition surface and ink. Labels always remain visible. Product and spending category references use the shared neutral record pill and canonical identity marks, in tables, details, suggestions, audit values and reviews alike, with the full root-to-leaf path as their accessible name. Compact pills lead with the leaf in ink and follow it with the muted ancestor path, which truncates first; pickers and the detail ancestry row read root to leaf. Category label adapters resolve vocabulary facts; they do not own a separate link presentation. Named domain tokens own wayfinding hues on both clients; the category ramp is available for deliberate assignments.

### Action

Action color marks the outcome of a pending decision: create is blue, link/attach is neutral graphite and inset, change is muted ochre, and remove uses destructive. This third channel never substitutes for navigation identity or condition ("what state?"). Primary buttons stay ink; action color belongs on chips, glyphs and step marks.

### Neutral

White surface, #FAFAFA sidebar, #F5F5F5 hover and inset, secondary ink and #E5E5E5 hairlines separate regions without decorating every record.

## Typography

Inter (self-hosted `@fontsource-variable/inter`) for identity, body, labels, controls, and tables; Geist Mono (`@fontsource-variable/geist-mono`) for shortcodes, money, counts and other tabular figures in tables, timelines and facts. On a desktop fine pointer body text is 12px (`text-sm`), section titles 13px semibold (`text-base`), page and record titles 16px semibold (`text-xl`), captions 11px (`text-xs`), pills and column headers 11px (`--pill-font-size`); control labels are 12px everywhere (`text-md`). The base scale for phones, coarse pointers and hosted workspaces is 13px body, 15px section titles, 20px page titles and 12px captions. Hierarchy comes from size and weight, with sentence-case labels (`text-xs text-muted-foreground font-medium`). `cubby/no-uppercase-utility` enforces sentence case; `cubby/no-arbitrary-font-size` requires the type scale (`text-3xs` 8px, `text-2xs` 10px, `text-xs`, `text-md`, `text-sm`, `text-base`, then `text-lg` and `text-xl`). Key-number strips use the page-title size in semibold Inter with tabular figures.

## Layout

Cmd+K and full search retain record identity and subtitle, followed by up to two
declaration-owned fact columns and the visible shortcode. Desktop facts align
across rows; counts, unformatted numbers and booleans retain quiet labels. Dates
use the shared compact presentation. On narrow surfaces all facts wrap beneath
identity with labels. Missing
facts preserve their column positions. The full entity type appears on shortcode
hover and keyboard focus and remains in its accessible name. Existing Product
family expansion and search ranking remain authoritative.

The desktop shell has a collapsible navigation sidebar containing global search and create, with contextual identity and actions in the page itself. There is no global desktop command header. The expanded sidebar is 176px wide, with 22px rows and 12px labels on desktop; the collapsed 40px rail keeps section flyouts and direct top-block leaves. `SIDEBAR_SECTIONS` in `packages/schemas/src/sidebar-manifest.ts` owns the order: an unheaded Today/Work block, Plan, Cook, Pantry, Garden, House, Purchases, Finance, Records, Dev. Settings stays in the desktop footer. Sections start open except Dev; persisted fold overrides remember explicit folding and unfolding, and a folded section keeps its current route visible. Inside an open section, records stay listed and specialist tools after the section's first record fold under one quiet Tools row with its count; views leading the section, such as Calendar, stay out as its front door. Counts remain quiet tabular text. The mobile More sheet shows the same sections in order, always open, with 36px rows and the same glyphs, header chips and current-row tints. Its title and destination search stay pinned while the list scrolls; Settings is a small bottom row. The modeless inspector is direct record context, with a sheet at intermediate widths and full detail navigation on phone. Preserve safe areas, virtual-keyboard behavior, and browser history.

A list row’s primary identity opens the record in the side inspector; checkboxes own batch selection and other cells retain editing/copying (J/K and visible step buttons move between rows, Enter opens the full page): a white panel with a 15px title and mono key, the declared key numbers as one inline line under the header (`KeyNumbers layout="inline"`), compact facts with "Add…" for empty editable fields, and hairline-topped sections; below 768px it is a full-screen sheet. The full detail page spends width to save height. It stacks a one-line identity header (about 56px, with the "Added" fact in the breadcrumb row), a declaration-owned summary strip (up to eight applicable linked-field, record-preview, report or chart cells), then a 208px sticky contents index with 22px rows beside the content: the entity's declared `detail.lead` sections, then Needs you (suggestions, quality findings and declared workflow prompts in one block) paired with the merged Activity timeline, then the remaining declared sections. `detail.pairs` declares sections that sit side by side, stacking below 1000px of workspace; relation tables cannot pair and stay full width. Lead and pair keys never reach generated Swift. Activity groups entries by household day with a date and calendar-day relative-age gutter; “Show older” continues the existing cursor pages. The index lists groups as quiet bold labels with their sections indented on a hairline guide, each led by its icon (a relation by its target entity's icon) and its row count; the current section follows the reading position, and a jump marks its destination. Jumps remain immediate for reduced-motion users. Empty sections read muted. Below the two-column width the index becomes the phone “Jump to”. Summary fields use the effective values the detail read carries; related records and report cells reuse their bounded canonical readers. Monthly spend readouts use portalled tooltips so strip clipping cannot hide edge values. The chart has one tab stop; arrow keys, Home and End move between labelled months without a second hidden copy of the data. Full record pages keep all empty fields visible. The inspector omits a field section only when every value is blank and there is no edit/Add affordance, custom renderer, or quality finding; its key numbers and Edit action share one line, and work needing input uses a sparse citron rule. An empty editable stored field reads as a quiet "Add…" that opens the editor, and a derived one as a dash. Fact sections at least 40rem wide reflow into two columns, and three at 60rem; narrow fact lists (the inspector) give labels a fixed share and start every value on one left edge, with no dotted leaders. Needs you collapses when nothing in it needs attention and shows a count of visible attention rows. Field info icons appear on row hover or focus; a row with a quality finding keeps a visible marker. A small identity thumbnail (28px) sits beside the title; the full gallery appears later in Images. Header actions wrap before squeezing identity. Lists retain compact workbench controls and horizontal table overflow rather than horizontal page overflow. Ownership evidence uses the shared RecordList in one content column.

The hosted native Run evidence workspace shows its declared report and timeline sections before record facts. Facts remain available afterward; record metadata must not push the transcript and logs several screens below the initial view.

Settings and long analytical workspaces (expense analytics, portfolio analytics, and cash flow) use `IndexedSections`: a continuous column with sticky contents navigation at 800px available width and phone “Jump to”, stable section hashes that preserve search parameters, and mounted drafts. A focused jump destination stays anchored while streamed content changes the layout, until the member navigates or scrolls. Embedded expense analytics stays inside the record’s existing contents navigation. Keep controls and summaries above the indexed body. Settings groups connections, mail and purchases, and household access; it links to Activity for maintenance, while connection diagnostics remain behind an explicit disclosure. Use tabs for distinct workflows rather than sections of the same page.

Today/Home titles itself with the household day and keeps Log meal and New task in the page header. A key-numbers strip (Tasks due, Needs you, Spent this month, Pantry on hand) leads, then Today (plain task and project names, with quiet commands) and Needs you side by side as ruled rows, then What changed grouped by household day with the day in a quiet gutter; each line names the record, the action and changed fields, the writer avatar with the client, device or non-web channel that carried the write and a Run icon link, then the time. From 1280px a right rail holds Meals, Money (recorded spend by month), Today’s nutrition, Pantry by location and Your views; below it the rail follows the main column. Records and Insights stay behind disclosure. Every figure is an existing query value; never invent pace, progress scores, risk predictions, or AI panels.

Background refetches keep loaded content mounted. Lists, inspector previews and
full detail pages reserve a compact status line for muted “Updating…” after
300ms of continuous activity; clearing it does not move the content. Failures
retain the loaded values, raw diagnostics and Retry. The shell retains its
reserved Syncing slot for household-wide activity. These browser read states
never imply that a computed value has been rebuilt; derived freshness marks
remain independent.

Loading placeholders use Skullet through the shared Skeleton primitive, with a
single light, static theme. Use its explicit boxes:
measured sample rendering must not mount record readers or actions, and automatic
shape persistence must not introduce browser storage. Keep record geometry and
accessible region labels; missing images may retain their semantic identity mark.

Actual value changes use one quiet info-surface tint across table cells, detail
facts and summary figures. It holds briefly and fades within two seconds without
moving content. Initial render, hydration and remount establish a quiet baseline;
unchanged reads, formatting-only changes and status/timestamp updates never flash.
Identity includes the record, field and semantic filter or projection scope.
An optimistic value followed by its identical server result highlights once.
Selection, focus and validation remain visible. Blue Updating dots and failure
indicators retain their independent meaning; work finishing with the same value
clears its dot without a value highlight. There is no new motion setting.

Mail coverage begins with flat mailbox-discovery and sender-resolution RTables,
followed by a disclosed unresolved-seller Email table and the Vendor × mailbox
RTable. Poll freshness, targeted historical search scope, classification and
import are distinct; local counts never imply Gmail-wide coverage. Source
addresses belong to Vendors through verified mappings. The Vendor table retains canonical
Vendor and Vendor Account links, explicit coverage states and separate local
Email and Purchase counts. Selecting a row opens the shared table inspector
for controlled import and date bounds; Settings retains mailbox switches.
Discovery completion and downstream import outcomes remain distinct.

The month calendar prints each day's number first, then bar lanes, then chips and "+N more". Two or more bars crossing at least five days of a row fold into one "N ongoing" lane across their combined extent; its popover lists them and the remaining bars close up beneath it.

Mobile discovery rows retain poll/catch-up and historical search summaries;
sender-resolution rows retain search state. The Needs attribution and Shared senders views use exact-address attribution state, never a shared domain as proof of sharing. Verified addresses appear on Vendors. Both sender and Vendor tables have standard row-selection checkboxes. Sender resolution uses the same search,
status views, column controls and row inspector as Vendor coverage, with compact
default columns. Vendor coverage separates Domains from Sender addresses.
Address controls expose the saved Vendor, learned/member origin, disputed/shared
state and original Email/Purchase evidence; member exclusions survive learning.
Address buttons stay within their table cell; the scalar accessor and inspector retain the complete value for copying.
The inspector exposes complete, selectable sender addresses,
queries, counts and Run links. Discovery retains its Details disclosure.

Record-summary previews always offer their collection count/link when populated,
even for one or two records. A matching web relation table is the destination:
full pages jump to its compiled section id, and inspectors open the full record
at that section. Views without a table keep Connections. Empty lead relations
retain a zero-count link and their table's creation affordance. Location leads
with Child locations, showing direct children and Add child location with the
parent prefilled; the table remains visible when empty.

## Elevation & Depth

Resting page and detail sections are open and flat, separated by 1px hairlines and whitespace. Section headings are plain semibold text; no gray bands and no cards around resting content. Rounded, shadowed containers are reserved for things that float: the inspector, popovers, menus and dialogs. Floating primitives share `popoverElevationClassName` and `--brand-elevation-popover`; the responsive schema inspector uses the same token only while floating. `cubby/no-shadow-utility` rejects sized and arbitrary shadow utilities; these floating surfaces carry explicit lint exceptions. Resting surfaces and table boundaries use flat hairlines. Motion marks arrival and consequence, and the keyboard outruns it. It respects reduced motion and uses only the shared tokens (`--brand-motion-exit` 100ms, `-fast` 120ms, `-standard` 180ms, `-slow` 240ms; `--brand-ease-cozy` for entrances and exits, `--brand-ease-move` for on-screen travel; shifts of 4, 8 and 16px). J/K, Enter, Esc, typing, search results, scrolling and cell focus stay instant. Hover and selection change color in at most 120ms. Pointer-opened popovers and menus rise from their transform origin in 180ms; dialogs take 240ms and sheets 180ms; every exit takes 100ms. Only opacity and transform animate. Images fade in over 120ms. Do not add page-load choreography, staggered or entering virtualized rows, sort reordering, height or width animation, skeleton shimmer, hover zoom or transition-all.

## Shapes

Web controls use 6px radii (26px buttons and inputs on desktop, 32px and 30px on the base scale, 22px navigation items), chips 4px (18px tall on desktop, 20px on the base scale), floating panels 8px. These web tokens are independent of native geometry. Inputs use a white surface and hairline border; nested surfaces keep concentric corners. Record pills are outlined with a hairline on a transparent surface, fill only on hover and use the 4px chip radius. Images use a faint neutral outline. `cubby/no-large-radius` rejects `rounded-xl`, `rounded-2xl`, `rounded-3xl` and their directional variants; use `rounded-md` or `rounded-lg`. `cubby/no-hand-rolled-panel` requires `Panel` for any rounded, bordered box; its `.oxlintrc.json` exemptions cover shadcn copies, `Pill`, pickers, overlays, ReUI, the date-picker input, text and code blocks, `EmptyState`, and the two Home files awaiting the Home rewrite.

## Components

### Suggestions and date spans

Field suggestions distinguish Current from Proposed with a quiet ochre action
surface (destructive for a proposed removal); confidence appears once. Accept stays ink, while reasons, alternatives,
source evidence and raw failures retain their existing review disclosure. Activity
rows may stack provenance beneath the primary change; an arrow stays attached to
its destination value rather than wrapping alone.
Proposal badges show a complete known count normally. Incomplete publication
coverage adds a plus to a positive count, or a question mark when none are known;
the accessible label and disclosure explain missing, stale or failed coverage.
These static indicators never imply that refresh work is executing.
Record and workspace Suggestions keep coverage visible above retained rows and
say “No known pending suggestions” for incomplete empty results. A failed read
keeps the last result beside its raw error and read Retry control.

A declared `dateRange` field uses one labelled control and saves both calendar-date
bounds together. Deadline fields offer Single date and Date range; period fields
keep independent optional Start and End controls. Typed entry and the shared
calendar remain available. Opening or dismissing the picker preserves end-only
values; Single date explicitly clears the end. Periods display From or Through
when only one bound is known. Scoped and bulk edits use the same compound value.
Record references and inheritance sources use EntityRefLink.

### Component sources and boundaries

Interactive design previews of existing workspaces run inside the actual
`AuthenticatedAppShell`, retaining its sidebar, navigation, logo and account
controls. Do not recreate app chrome in generated mockups or prototype code;
exploration changes only the explicitly requested content region. Prototype
records are synthetic and writes stay in memory until production implementation
is explicitly in scope. Representative previews compose existing shared controls
and field renderers, retaining rich pickers, enum glyphs, inheritance, suggestions,
validation and date behavior; native dropdowns and hand-built imitations do not
establish whether an existing Cubby workflow improves.

`components.json` configures the shadcn Base UI/Mira family. `src/ui/primitives`
holds only whole shadcn registry copies that `shadcn add <item> --overwrite`
refreshes; Cubby-owned components never live there. `src/ui/reui` holds copied ReUI
items, including Badge and Alert (source and license in [`src/ui/reui/SOURCE.md`](src/ui/reui/SOURCE.md)),
and every other folder is Cubby-owned. Base UI owns accessible interaction,
while Cubby owns styling and composition. Registry copies keep their unused
parts so refreshes diff cleanly; Cubby's deltas on them (brand tokens and
motion, Phosphor deep imports, popover elevation, hydration gates, mobile
sizing) stay small and are re-applied after each refresh, and density or color
belongs in theme tokens rather than class strings. Classes merge through the
`cn` package with stock tailwind-merge, so custom font sizes use t-shirt names
(`text-md`) that it classifies as sizes. Filters and file upload are
Cubby-owned. Prefer existing shared components before importing registry items.

To refresh a registry copy, run `pnpm --dir apps/web exec shadcn add <item> --dry-run --diff`
and read what upstream changed, then `shadcn add <item> --overwrite --yes`. Revert
anything the CLI wrote outside the item (`styles.css`, `package.json`, the lockfile,
`components.json`). Re-apply the Cubby deltas listed above from the previous copy
with `git diff`, keep call-site APIs, and run typecheck and lint.

Cubby-owned shared UI is grouped by job: `text` (inline labels, pills, links),
`values` (formatted scalars, money, dates), `records` (record lists, ledgers,
facts, people), `media` (images, glyphs, documents), `dates` (date inputs and
the DayPicker calendar), `tree`, `forms`, `feedback`, `overlays`, `layout`,
`navigation` and `data-table`. `ui/hooks` holds only generic hooks. Hooks that read
entity data live under `entity/`; the household-date and auth hooks live in `lib/`.

Use `RemoveButton`, `MoreMenuTrigger`, `PrevNextButtons`, `TileOverlay`,
`InlineEditActions`, and `KeyHint` for shared controls and legends.
`SubtaskProgress` owns task checklist badges.

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

One look per job: a page composes these instead of styling its own header, figure strip, box or empty message. `cubby/no-hand-rolled-panel` keeps rounded bordered boxes inside `Panel`.

- **`PageHeader`** (`ui/layout/page-header.tsx`) — every page's identity row. `stacked` puts a breadcrumb over the title and a fact line under it (record details, Home); `inline` keeps facts beside the title (list and tool pages). One status chip, actions that wrap before squeezing the title.
- **`KeyNumbers`** (`ui/records/key-numbers.tsx`) — headline figures. `strip` is a hairline-ruled row of label, value and context that reflows on narrow widths (detail pages, dashboards); `inline` is one muted line of bold values (the inspector, compact summaries). `onSelect` and `active` make a figure a drill-through filter.
- **`Section`** (`ui/layout/section.tsx`) — every resting region: a semibold section title with optional mono count, quiet actions and a takeaway caption over a hairline. `compact` for nested regions; `empty` mutes a region with nothing in it; `disclosure` folds it.
- **`Panel`** (`ui/layout/panel.tsx`) — the only bordered box. `tone` is required: `default` (hairline) for focused flows and repeated items, `muted` (fill, no border) for supporting material set apart inside a flow (previews, diagnostics), `warning` (tinted fill) for a callout that needs attention. Optional `title`, `caption`, quiet `actions` beside the title, edge-to-edge `media` above it, and `flush` for tables.
- **`EmptyState`** (`ui/feedback/empty-state.tsx`) — `inline` is a dashed slot inside a section with an optional link; `page` centres an icon, message and one action for a whole empty list or search.
- **`Toolbar`** (`ui/layout/toolbar.tsx`) — a labelled `toolbar` with `start` controls, `end` search and a `below` row for applied filters; search wraps onto its own line on phones.
- **`Disclosure`** (`ui/layout/disclosure.tsx`) — a quiet chevron summary with `meta` and an `aside` that stays on the summary row; bodies mount when opened unless `keepMounted`.
- **`Facts`** (`ui/records/facts.tsx`) — labelled values; see [Records, forms, and tables](#records-forms-and-tables).

### Custom-built signature components

These are Cubby's own components, designed and built here rather than adopted from a component library; the headless pieces under them (Base UI popups and focus, TanStack Table state) carry no visual design. Required native-browser previews own their rendering:

- **`Picker`** (`ui/combobox/picker.tsx`) with `PickerField`, `PickerVisual` and `PickerOption` — every value choice: choose, search and segmented modes, single and multiple values, records with pictures and options with glyphs.
- **Records ledger and timeline** — `RecordsBlockView` (`entity/entity-detail/records-block.tsx`), `Ledger`/`LedgerRow`/`LedgerCell` (`ui/records/ledger.tsx`), and `RecordList` with its `Record*` parts (`ui/records/record-list.tsx`).
- **`RTable`** (`entity/table/table.tsx`), reached through `ListWorkbench`.
  Thematic column groups are metadata, not a header band. Columns exposes whole-group visibility and
  movement; leaf sorting, filtering and sizing stay on individual headers.
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
- **`IndexedSections`** (`ui/data-table/indexed-sections.tsx`) — the continuous grouped page with its sticky contents index and Jump to menu; record details render through it.
- **`LocationTree`**, `DateDisplay`, `EnumPill` and `FilterBar`.

Debug JSON remains read-only and expandable through `ui/text/json-renderer.tsx`.

### Shared headings and actions

`Page` is the sole list/detail shell; `PageHeader` (`ui/layout/page-header.tsx`) draws every identity row and `src/entity/page/entity-page-header.tsx` composes it for records and lists. Detail identity is an open header with a structural bottom divider, thumbnail, wayfinding, readable title, quiet metadata, and inline stats. Keep Edit and the main workflow action visible; remaining review and destructive actions use accessible overflow. `Section` owns the flat heading row (strong text over a hairline rule) for details, forms, dashboards and Home, with sentence-case headings, explicit heading levels and a shared disclosure trigger. `Panel` is the bordered box, kept for focused flows (sign-in, consent, triage stops), repeated list items and callouts.

### Controls and suggestions

Default desktop buttons, non-form controls and form controls share 26px. Small buttons and menu items are tighter (24px). Phone interactive targets retain at least 44×44px. Primary buttons use ink; outlined, secondary, ghost, and destructive variants retain distinct treatments. Focus uses a visible ring without layout shift; invalid and disabled states remain distinct.

Every value choice is one `Picker`, dense like a menu, never like a form card. Record popups grow to 36rem or the field's width, bounded by the available viewport; fixed choices retain the field width (growing to at most 16rem for narrow fields). Lists have 4px padding and no row gap. Rows have a minimum height of 28px desktop and 44px on phones: one fixed 20px leading mark (the record's picture, else the option's tinted glyph, else a swatch — never two), a flexible wrapping name, aligned secondary/status and right-aligned mono data columns, and a reserved checkmark column. Missing metadata leaves its column empty. Enum subtitles retain the declared label and semantic color through `EnumPill`; figures are tinted only for a real condition. On phones metadata wraps beneath the name. Search-match and disabled reasons remain beneath identity; trees use quiet sentence-case group headings and indent. Opening a populated search picker reveals the selected row without reordering the roster, scrolling the page, moving input focus, or repeatedly resetting manual scrolling. Typing searches the full candidate scope. The closed field repeats the selected row's mark and, when it has room, its first chip. Segmented mode is the same picker inline for a handful of view modes or formats.

Record-option discovery follows the declaration's fixed, entity-backed or
relationship-scoped source. Growing rosters search the full eligible scope,
load the next page near the scroll boundary, and retain a keyboard-accessible
Load more action. Opening alone never drains a record roster. Fixed choices
and deliberately complete vocabularies search locally. Canonical entity marks
are shared across result rows, selected values and filter chips; counts occupy
the trailing mono column rather than becoming part of the name. Selected
records remain named and removable outside the current result page or search.
Searching, Loading more, no matches and failed reads are distinct. A failure
retains known rows, exposes its raw diagnostic and offers Retry; it never
claims no matches. Paging preserves input focus and manual scroll position.

Status, enum, category, and suggestion values share `Pill` geometry. Saved status values retain their tone surface and category values use quiet matching tints; a pending suggestion is the value's own chip with a dashed action-change boundary, its sparkle replacing the thumbnail, and its actions in the cell's hover rail rather than a nested chip. Applying a suggestion shows cell-local pending feedback. Stored and live suggestions share the same surface contract. Empty suggestible cells keep a compact visible status, with details available on hover, keyboard focus, or activation: checking, skipped for missing evidence or candidates, no suitable match, below the review threshold, rejected, or failed. Missing evaluation history is explicitly unknown; it does not establish that evaluation never ran. Populated fields hide routine settled status and retain actionable proposals and failures. On detail pages and inspectors, a field suggestion shows the proposed value and Accept inline, on desktop and phone alike. Its field label and explanation control align with the proposal line in both collapsed and expanded Review states. Review expands beneath its owning row to expose confidence, runner-up, basis fields, evidence, Reject, and “Use a different value…”. Decision details contains provenance (model, time, Run, AI usage) and explains how a different value is recorded as a Miss. Table marks retain anchored popovers to preserve row geometry. Meaning never depends on a title attribute. `AiProposalCard` remains for prose proposals and uses the same confidence and Accept wording. An answer the server already saved (a location's analyzed contents) reads Previous and Saved with one Done action; it never offers an acceptance it cannot make.

### Records, forms, and tables

List controls share the compiled list-field vocabulary. Columns lead with the
visibility checkbox and field label; the canonical entity mark follows the
right-aligned type label. Headers and record links retain leading marks. Group
and Sort choices lead with the canonical entity or type mark. Group selection
shows 1st, 2nd and 3rd explicitly; multivalue guidance explains whole-record
filtering. Column actions disclose field descriptions and unavailable operations.
Supported hidden fields remain available in Sort. The section action reads
"Exclude matching records" and explains its effect on every group; Collapse
closes only that section. Phone controls keep the base target size and grouped
list layout.

List money keeps whole-record totals separate from relationship-attributed
amounts. Compact footers and group rows show Seller spending and Unattributed
spending; a focusable information control opens contributor definitions,
coverage, plans and reimbursements. Unknown costs read as Unknown or partial
beside a known subtotal. Footer facts wrap on phones. Pivot's Measure control
offers the same declared metrics with signed values and distinct contributor
totals. Record counts still explain membership and overlap; money does not use
count percentages or count heat shading.

Pending Suggestion counts sit beside a record's identity as quiet, focusable
badges that open the shared record review in a popover. Record details host
that review as a section. Automatic decisions have their own RecordList and detail section, with
family and review-status pickers in the list’s compact control row, with a quiet count beside the page title, affected-record links, a readable decision and
Wrong. Unverified legacy applications say so beneath the decision; raw payloads
stay in an explicit Technical evidence disclosure. Family declarations choose
the actions and evidence; clients do not create another family review screen.

Entity declarations own names, domains, images, fields, view choices, relations, sections, and action availability. Generated route shells and `GenericEntityList`/`GenericEntityDetail` render them. An entity-specific page may supply a declared slot or necessary query adapter; it does not introduce its own page chrome. List workbenches use one compact desktop row: system-sans identity and a quiet count, search, `Filter`, a `Display` popover holding layout, sort, group and columns, then actions. Saved views follow as line tabs whose single underline travels between them. Controls wrap when their content needs room; the title never steals the search input’s usable width. Inactive filters stay inside the disclosure. Active-filter chips appear beneath the band only when filters are active. Full filtered totals and suggestion status live in an always-visible footer as tall as a table row, with the sweep action in Actions; errors and diagnostics remain visible with their controls. A list with an active result filter whose membership is unknown or has unresolved records keeps that state and its Show unresolved / Show known matches control in the footer; a list with no result filter has no such concept and shows nothing. During tab, sort, filter and group changes totals keep their prior values dimmed, and "Unavailable" means a failed read. Phone identity and query tools get full-width rows; view and creation follow in the same reading and focus order. The filter/sort sheet remains. Filtered empty tables, phone rows, and cards share the same clear-filter recovery action. Every declared filter, column-hosted or not, lives in the Filters disclosure; a deep-linked scope shows as an active chip like any other filter. Card placeholders use a quiet entity symbol rather than a repeated decorative title. The external USDA catalog remains an external-reference exception.

A complete record uses a clear human identity, optional true media, compact metadata, declared facts, direct relationships, supporting evidence, and actions the entity can actually perform. Fact, workflow and relation sections follow the declaration’s authored section order, and a field a summary cell shows is not repeated in a later fact section. Fact groups and workflow sections use distinct headings so record navigation stays unambiguous. Detail titles and primary actions align on desktop. Available `detail.quickActions` render as filled buttons ahead of the primary verb and its menu, and `list.quickActions` lead each row menu. Directly beneath them, the declaration-owned summary strip shows up to eight applicable cells: linked facts, up to two related records with a total and destination, concise report figures or progress, and charts. Cells share flat ruled boundaries and responsive columns; prose wraps while record names stay on one line. Charts participate in the same ordered roster. Header cells use compact vertical padding and a 64px spend plot; supporting row metadata shares a line when it fits. Direct links omit a redundant “Direct” caption, while indirect witnessed paths and coverage notes remain visible. Field, record and report references batch their covers through the shared display-image resolver, including transitive images; path intermediates use that same image context. Content determines height and wraps without a fixed-height clamp. Optional empty relationships disappear, while unknown, loading and failed values remain explicit. Full details continue below; this strip never becomes a second Overview section. Scalar facts use the shared `Ledger` facts layout: semantic label/value rows, quiet horizontal rules, aligned values, and a separate right-aligned action rail. Labels have a bounded readable column rather than taking half the record width. Derived provenance uses the shared leading mark; decision and reset actions live in the value explanation. Read-only fact rows may be tighter than controls; phone links and actions keep their 44px target. Prose gets full-width space. Supporting metadata uses compact inline text. Summary cells group useful context without floating cards, decorative fills or isolated zero counts. Only declared pairs split into columns: beside the table of contents, every other section spans the full work surface in declaration order, and the full gallery stays in the declared Images section. Section actions wrap at narrow widths, and overflow-enabled sections remain unclipped by their plane. The header uses only a small identity thumbnail; gallery and image-management controls stay in the declared media section. J/K record stepping adds no movement, and images never hover zoom. An inspector reuses the record’s declared fact groups, inline editors, suggestions, and contextual quality results in one continuous body. Its compact header has a small cover, wrapping identity, Open record, and full Edit; it does not reserve a large image card. Relations and Activity expand on demand and remain mounted after opening. Heavy workflow sections remain on the full record, linked from their contextual checks. Inspectors retain detail click-to-edit behavior when hosted by a table. Portaled scalar editors keep their controls within both viewport axes, including during resize, and scroll when their content exceeds the available height. A row click inspects; a checkbox selects for batch work.

Detail summary cells use one column on phones, two at intermediate widths, and
four on wide pages, so the first row is the record's glance: the first four
declared cells. Keep fact labels beside their values and omit single-fact cells whose
value is absent; the complete facts remain below. Preview at most two linked
records, retain totals and destinations, and keep pill names on one line. Compact
spend plots are 40px high. Routine report explanation and longer previews expand
with Show more; warning, destructive and strong notes remain visible.
Later contextual cells fold under More context; field groups and alert reports
remain visible. Expanding context retains the complete linked evidence and facts.

Every applicable quality check has one visible result beside its declared field or owning section, including satisfied checks. No check takes a page-level heading on a record page: the display-image check lives in Images, scores print without decimals, and Needs you counts only real attention rows, never loading rows or diagnostic status lines. Absence reads as one muted "Not recorded" with Add on hover; named domain states stay. Satisfied labels describe the recorded fact positively; missing data, defects, accepted exceptions, and neutral coverage retain distinct meanings. A compact quality summary links to the owning result. Explanations expand beneath their row; weights, caps, and score arithmetic remain on demand. Contributions describe checks, not invented per-field point deltas. Ordinary supported field values edit directly while full Edit remains available for coordinated changes, including declared editor exceptions. Inherited values display their effective value and retain an explicit way to return to inheritance. A conditionally hidden section cannot own an invisible quality result or a dead summary link; those checks need a visible fallback.

Full record details are one continuous, mounted page. Declared sections retain their Overview, Work and Evidence grouping; Relations and Activity follow, and formerly separate supporting views join Evidence. A wide work surface has a sticky, independently scrollable table of contents with every group and its indented subsections expanded. Below 800px of available record width, a compact “Jump to” menu exposes the same hierarchy. Links scroll and focus their stable section targets; scrolling updates the current entry without adding history. Explicit jumps retain URL fragments and browser Back/Forward. Section bodies start open; existing pagination and Show more controls remain. Relations and sections with a known count of zero fold into one "Nothing recorded: …" line whose names unfold them; unknown and failed reads stay expanded and are never reported empty. The outline lists populated sections. List sections (relations, Connected records, photos, documents, sources) show their row count, 0 included, beside the heading and in the contents; other sections show no number, and an empty one is announced as Empty to assistive tech only. Contents entries are single-line and truncate, counts sit in a right-aligned tabular column, group labels use quiet sentence case, and one current-entry pill travels behind foreground text in 180ms. Every generic entity detail includes one grouped Connected records section under Relations — every declared local relationship and inverse, including same-type links, joins curated multi-step routes in one group per target entity kind; each populated group shows its first three distinct records and a link to the complete view, while empty groups fold into one "No connections" line. Rows align a Via column with a short relationship explanation that expands to linked witnessed records and every distinct path. Tables, summaries and header context share the same path presentation. Equal labels for distinct records include their shortcodes — then Relationships, which on a detail page is the graph explorer alone: the record's own relations, similar products and physical connections already appear elsewhere, so it never lists them again. Loading and failed reads never count as empty. Drafts stay mounted. Navigation starts immediately; section jumps never smooth-scroll. Apple uses native Contents navigation; Run evidence and Connections use isolated hosted sheets. Related-record links return to native routes. The authentication and bridge contract lives in `apps/apple/DESIGN.md#hosted-workspaces`.

The generic record editor lays fields out like the Ledger facts it edits: a quiet label column beside each control, stacked below a 26rem form width (the phone sheet). Identity fields lead; the declaration's edit sections order the rest. A field shows an AI suggestion only when it can act on it; the form's one status line and its breakdown report agreements, declines, and below-bar picks. A direct reference does not repeat "Linked to" under its picker. A date clears with its own ×; a separate clear button appears only for a named state such as "Date unknown". An update dialog's subtitle names the record being edited. A form taller than the dialog scrolls between a fixed header and footer.

Read-only detail lists use `ui/records/ledger.tsx`: `Ledger`, `LedgerRow`, and `LedgerCell` share container-aware columns, separators, trailing alignment, and compact row geometry. Facts preserve `dl`/`dt`/`dd`; record rows preserve list semantics. The two structural variants are facts and records, with composed leading, primary, secondary, trailing, actions, and expanded-detail slots. Links, editable values, choices, commands, raw diagnostics, and image sizes remain with their existing renderers. Rows with photos or form controls put their evidence below identity instead of squeezing controls into a leftover column; the photo spans those lines. Labelled values are facts, never "·"-joined prose: `Facts` (`ui/records/facts.tsx`) writes a muted label and a foreground value, `layout="inline"` in rows and evidence and `layout="list"` for detail and inspector properties (headline figures use `KeyNumbers`), and a list whose rows share facts declares columns so each value sits under one quiet header label, wrapping to inline labels below 40rem; values wrap rather than clip. Read-only record lists use `ui/records/record-list.tsx` on that geometry: table-height rows with hairline rules and a muted trailing fact (time, score meter, hop count, writer and time), quiet sentence-case group headings with counts, a closing "+N more" row, one folded line for absent results, and loading, error and empty states that never read as each other. Activity record links use the available row width, with single-line desktop identities and an aligned shortcode column. Phones stack codes beneath naturally wrapping identities. Full identities remain available on hover and keyboard focus. Activity feeds batch-resolve display images for the loaded records. All record pills consume the shared canonical image context; the shared app provider batches mounted references that no collection already owns. Home’s Today tasks keep the task and project on separate lines beside a compact stacked due date. Its timeline variant draws Activity and entity timelines: a rail through action- or kind-colored dots, a heading per household day, and rows that print only their time. Entity timeline kind chips use member-facing labels: a declared-date kind reads as its field's label and its row does not repeat that label as detail. Lifecycle bars and markers carry their span, or date and kind, as accessible names, not only as hover text. Connected records, relation evidence, similar products and recommendations, relationship branches, physical connections, graph list rows, sources, report rows, Run attention rows, and Activity all render through it; RTable and charts keep their own layouts.

Every report `records` block draws as one ledger, and ordered stages (a pipeline, run progress) declare `timeline`, which adds a rail from the first mark to the last: one aligned line per row with its `state` mark or thumbnail, its title (the chip of the record it opens, when it opens one), any state other than done spelled out beside it, its badges, its result and evidence lines one under another, its figure and time, and commands. Each quiet line clips on a wide row with its whole text as a tooltip. A block's own commands follow its rows, as on native. The server folds a run of the same timed event into one row with a `×N` figure and each event's time and evidence in its detail, and the AI usage report groups calls by operation, model, transport and outcome under Charged, Standard and Savings figures, because a sweep repeats one call hundreds of times. A badge or line every row would repeat (a log's source, a call's transport) is a muted line, not a chip. States have distinct marks: done, warning and failed are filled condition dots, running is an ink dot with a slow pulse (a still halo under reduced motion), skipped is a hollow ring, and not reached a faint point — never a dashed ring, which reads as loading. Machine codes in evidence read in mono. Failures and warnings wrap in full. Row commands are quiet ghost buttons inside the row's height, links out carry an outbound arrow, and once any row has commands every row keeps that column so times share one right edge; on phone, commands sit under the text, aligned with it. A command that needs input opens beneath its own row rather than standing open. Timed rows that share a household day print only their time, with the day once in the block heading (or as the list's first line for an untitled block); rows spanning days print day and time; relative time is in the tooltip. Sources follow the same shape: the document and its shortcode, one line of the fields it supports (or the path it is related through), when it was seen, and its citations (field, variant, quote, when and by whom) behind a disclosure that starts open only for a lone source. A state mark sits on its row's first line.

Run phase progress shows known processed/total counts, percentage, remaining
units, and a qualified rate/ETA. Unknown totals use a moving ink segment;
reduced motion keeps that segment visible and stationary. Progress owns its
activity animation separately from intentionally static loading skeletons.

A step-ledger Run's detail (`features/run/run-detail.tsx`) never blends steps
into one percentage. `RunStepStrip` draws one 6px segment per step, filled by
that step's own frozen count. Done segments are ink at 55%, running ones info,
and tally steps a sliding info segment. Steps sit on the RecordList timeline:

- **Marks.** Running is a pulsing ink dot; waiting is the same dot held still
  (`RecordDot state="waiting"`).
- **Card content.** Each card states its purpose and an input-mode tag
  (Counted input, Provider estimate, Tally).
- **Count mode only.** Only count mode draws a bar, percentage, rate and ETA,
  plus the "Frozen at step start" boundary. Waiting steps keep a lighter bar
  (`Progress paused`) and say "Rate paused".
- **Not started.** A step that hasn't started reads "Not started" and "Counts
  its inputs when it starts".
- **Moving step.** The moving step adds:
  - one "Speed set by …" line from the limits catalog;
  - the last page's time per phase with its queries (or "not measured");
  - value-first tallies (`KeyNumbers layout="tallies"`);
  - wait reasons as a tone pill over the raw stored detail;
  - the reason funnel ("Where the items went").

Run detail leads with purpose and meaningful results, followed by specialized
review tools in Work. The full record-facts roster belongs in Evidence. Photo groups retain their image comparison/editors; purchase
findings and prepared orders retain domain commands. Input targets render through
an embedded `RTable`, with Record, Status, Outcome / reason and Source columns,
search/status filters and the shared inspector. Name links open source records;
row clicks inspect evidence. Assessment ledgers reuse the shared suggestion
review actions and evidence, with server-authorized fingerprints.

Needs attention is the initial view only for supported decisions; otherwise show
Results. Processing, skipped and blocked items remain discoverable in Results.
Refresh existing values in place, preserve admitted row order and inspected
items, and hold arrivals behind Show new items. Resolved attention rows remain
until the member refreshes the view. Photo batch approval uses ready items in the
filtered view unless explicit selection takes precedence; show that scope and
its concrete effects before application.

Run figures and funnel rows drill into the decision ledger. The ledger is the
step's declared results family, read through a family presenter. It has facets,
search, J/K/Enter, `/` and Esc, and stacked rows on phone. Evidence opens in a
`SidePanel`. Steps, Decisions and Diagnostics retain their declared anchors.
Execution evidence follows Work; steps, detailed progress reports, diagnostics,
transcripts and usage start folded on web, and a direct section jump opens its
body. The thin live phase summary remains mounted to synchronize Run status. Ordinary
record sections remain open and review drafts stay mounted. Completed Runs keep
results and supported corrections/retries; completion is never a success claim
for every item.

The dedicated Work queue is a workbench table across record types. Its
default Summary layout ranks reasons by full-population work-item count and
shows share of the filtered total. Pivot uses the shared `EntityPivot` renderer
for Reason × Type; Records retains the workbench table and group actions.
The compact Summary / Pivot / Records picker is shared by the embedded Needs
you queue and the full page, where layout is URL state. Summary counts and
pivot cells drill into Records without dropping scope or other filters. One
record may have several work items; an item may have several reasons. Reason
counts can overlap while totals and Type margins count each work item once.
Incomplete-coverage notices stay above all three layouts. The Summary's reason
labels wrap, numbers align right, and the count cells use the shared heat ramp.
Its workbench band carries line tabs (All, Review, Research, Waiting, Automatic)
with each view's server total in mono; a tab presets the View filter, beside
the Type, Waiting for, Kind, Source, Reason and Vendor any-of filters. Each
offers is and is not through the shared filter editor, including Filter… in
the column header menu. Type includes Problem for rows without a record type.
Reason choices use stable branch or Problem keys and the cell's declared
labels; a gap row belongs to each failing check, labelled by its message.
Excluding a check removes rows carrying it while keeping unrelated work and
the remaining rows' complete explanations. Finding summaries stay in Record
and their Reason is Finding. Filters,
sort and Group by (Type, Waiting for or Next action, sectioned by the server
ahead of the sort) are URL state, and the shared infinite pager loads more
work on scroll. Columns are the record's image, Type, Record (the record's
link), the shared Quality count (unsortable: it is stated after the page is
read), the Vendor chip, sign-toned Amount, Reason, Waiting for (member
avatar chips or the Either and Unresolved pills), and the rule's details with
one Review or Open; Next action, Kind, Date and Source are Columns-menu
toggles, because a rule's next action repeats down thousands of rows and
belongs to Details and the inspector. A gap row's reason is its gap messages
as sentences. Waiting for uses the current household member roster, Either
for shared work and an explicit Unresolved state with its explanation.
Clicking a row inspects its record (J/K step, Enter opens the full page);
Suggestion, Run and Problems rows open through their own link. Checkboxes
select record-backed work independently of the inspector, and a floating
dark selection bar offers only the queue's bulk actions: Copy codes (source
shortcodes, deduplicating records with multiple work reasons) and Select all
N matching. Aggregate Problems rows have no shortcode and are not selectable. A record's own rows appear on its detail
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

Photo review shows item and label media together when both exist, without an empty
label tile for items that have no label. Show Unreadable when a retained label
completed analysis without readable text. Pending/failed/skipped analysis and skip
reasons stay explicit. Ready identity details remain folded; genuine concerns or
missing inventory destinations expand for attention. Run defaults collect storage
location once; an explicit batch apply shows Product and stock effects and does not
overwrite item exceptions. Do not repeat absence beside every form field; use
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

RTable owns interactive record work: virtualization, pinned and resizable columns, in-session layouts, filters, selection, clipboard, grouping, inline editing, and aggregate footers. Desktop data rows are 24px with 24px headers (`ROW_DENSITY`), and every cell holds one line; the base scale keeps 32px. Every cell value gets the same 4px start padding; decorated cells render through `CellFrame`. A column is as narrow as its values: info, relation and resolution controls appear only on the hovered or focused row, over the cell's free edge, and reserve no width; a derived value reads muted, and suggestion marks stay visible. Columns have no vertical rules; only horizontal row hairlines and the pinned-column boundary divide the grid. Counts, quantities and money in cells read in Geist Mono at `text-xs` so a column aligns by digit; dates use tabular figures. An empty cell is blank; an editable one shows a faint Add… on row hover or focus, while N/A, loading, failed and unknown stay visible, and an unknown owner is a dashed avatar beside Unknown. Boolean No is blank and Yes a 12px check. A column bar is a 3px bar at the cell's foot. Quality scores remain numerically sortable but their pills start at the same padding as other categorical values. Table thumbnail frames match the row height and the image column reserves exactly that frame. The identity column pins beside selection and image, capped at 240px and yielding on narrow panes; the pinned boundary appears only while scrolled. Every table of records leads with its image column: the record's own image, else one borrowed through its declared relationships, else its entity icon; a row about another record (a Suggestion, a recipe line, a link candidate) shows that record's. RTable throws in development when a table has neither an image-role column nor a stated `withoutImages` reason, which only rows that are not records give (usage tallies, aggregates, nutrients, unmatched statement lines). EntityRefLink defaults to one neutral record pill: 18px high on desktop (22px on the base scale) with a 14px (18px) canonical image or record mark. Inside RTable, a normal enum value reads as a 6px dot and text, and only warning and destructive tones keep a filled pill; labels are never clipped. Sentence columns declare `prose` and fit their text up to 480px. The table name column opts into `bare`, which renders only linked text; other record-reference cells use the default pill. Image resolution is batched by the owning collection and follows declared transitive relationships. Every entity uses the same presentation; entity declarations supply identity facts rather than custom pill layouts. Option pills hold enum values only; a person or a record is never an option pill. The structural selection column is fixed at the row height; info controls use a 16px desktop footprint with a 10px glyph and preserve the coarse-pointer touch floor. Hover, inspected-current, and batch-selected states stay distinct, including pinned cells, and a selected inspected row shows both. A cell range takes an 8% link-blue surface inside one hairline perimeter, and the anchor cell an inset focus outline. Group bands differ from the row hover surface. Resizing shows a live 1px link guide; unpinned overflow fades at the scrolling edge, and the sticky header gains a hairline once rows pass beneath it. Overdue dates read in destructive ink with a 2px start edge rather than a filled cell. The totals strip meets the table directly; a portaled empty toolbar must not leave a separator or spacer behind. The shared table fits columns to rendered headers, aggregate footers, and a bounded sample of current values, within their declared limits. Fits remain stable while inspecting or editing, manual resizing wins, and no column grows past its kind's cap to fit one long value, and spare width goes only to the record's identity, up to 240px ([column widths](docs/web-ui-reference.md#column-widths)). Header labels use their short form on one line, fitting their column up to 160px and truncating past it with the full label in the title; a count of one entity's records is headed by that entity's icon and "#", and a column of links to one entity carries that entity's icon in its header rather than on every row. A header's sort arrow takes width only while the column is sorted, and its source icon appears on hover or focus. A clipped single-line value spills over its neighbours at the same row height on hover or focus; the spill belongs to its source cell, so the pointer can travel across it to the copied explanation control, and presses on it reach the source cell. A popup opened from a cell's rail keeps that cell and row active until it closes, so crossing other cells on the way to it does not close it; codes (barcodes, order ids) keep their first and last four characters, and other long labels keep their tail. Record pills truncate in dense cells and wrap in prose; contextual facts remain outside the pill. Quality scores drop "/100". Quality scores stay visible even at 100; complete records use muted numerals and retain their spoken status. Every RTable identity/name cell shows one line of name text, with no caption, subtitle, account pill, or other content underneath. Secondary facts belong in their own columns or review evidence; custom renderers follow the same rule. The native `list.titleSubtitle` setting has no effect on web tables. Shelf cards retain their declared subtitles. Record pills and enum pills have separate semantic owners; filter record choices reuse the noninteractive record-pill presentation. Dates and timestamps use one `DateDisplay`: full date/year and timestamp clock time followed by muted relative text outside tables; in tables, the day and compact distance share one line ("Oct 13 · 3 min ago"; months use "3 mo ago", and another year leads, "’25 · 1y ago"), and chip lists hold one line and count the rest as "+N"; secondary context is type hierarchy, never parentheses. A table view never becomes a stack of decorative cards on desktop. Phone rows use a semantic projection with a 44px minimum target: one truncated name line, one subtitle line, and one contained trailing value; further trailing values lead the subtitle.

The shared Columns control is a searchable, compact checklist with quiet group
headings and row hairlines. Checked means shown; hidden rows keep readable muted
text and a neutral fill. Explicitly hidden columns say Hidden; automatically folded
columns say Empty in these rows and can be revealed in place. Group checkboxes
show mixed visibility. Row menus hold keyboard movement and pinning actions;
pinning explains when it moves the whole group. Changes apply immediately and
Restore defaults uses the existing layout owner. Entity marks derive from the
manifest target in headers and column controls, including related previews;
header identity does not change record-cell imagery. Field types stay visible in
column and filter lists; exact supported operations are disclosed in the shared
focused filter editor from its capability metadata. Scalar types do not add glyphs
to ordinary table headers. Phone controls retain the shared touch-target floor.

Headers carry their label, with relation entity glyphs only, and drag sideways to reorder through the existing column-order owner. Each opens a column menu from a caret on hover or focus (the caret holds its own slot, leading on numeric columns, so it never covers the label or sort target): sort ascending or descending, Filter… on every filterable column (opening the shared focused filter editor with the table's draft and facets: in the filter bar's panel, or beside the header when the table has no toolbar), Clear filter while that column is filtered, Group by when the entity declares that grouping, pin, and hide. A filtered column shows an info-toned funnel beside its label. A column empty in every loaded row leaves the grid for one quiet "+N empty" footer menu that names and reveals them, unless the person sized, sorted, filtered or pinned it. Created and Updated stay hidden unless sorted. Right-clicking a row or cell opens that row's own action menu at the pointer; native editing and selection menus win, and touch keeps long-press. Its menu keeps the same hover caret and stays mounted as rows and visible columns change, so a live filter edit can continue through an empty result. Embedded relation tables take their declared section grouping and sort (Project Tasks group by Status, latest due first), omit the column that points back at the record they sit on, and may regroup or filter from a header for the visit. Their filters live in the table's own state, not the URL, so several relation tables share a record page; they show no chip row, only the header funnel. The server applies them through the relation's own list query and facets; a filtered-empty result keeps the table so the filter can be changed, and the section count and empty state still describe the unfiltered relation.

Tables expose a Group control only for declared grouping choices. Declared problem views tint their counts from the existing problem classification. Active-filter chips are 18px with 4px corners and 11px text; toolbar search and buttons are 26px. Headers, the Filters button and active chips open the same focused filter editor. All filters returns to its searchable field list. Record choices show the canonical identity pill with useful secondary facts below and counts separately; enums remain compact, while dates and numbers use typed bounds. Edits apply immediately through the existing shared draft and URL state. Filter sections use sentence-case labels, typed rows, inline boolean choices and a live count. Whole-table empty states use `EmptyState` page geometry. Initial desktop loading draws ten row-height skeletons under the actual columns. Group headers stick while their rows scroll, with totals under their money columns (the sum, then a muted mean) and the grouped column hidden. On desktop and tablet, a list with two groupable choices offers Pivot in Layout: the first Group by field makes rows, the second columns and a third collapsible sub-rows, drawn with `CrossTabTable` and the matrix chrome. Cells show the count with a Count / Row % / Col % / All % segmented choice, shaded on the shared heat scale against the chosen row, column or grid total (Count shades against the largest cell). Total column and row count each record once and a quiet note explains overlapping values. Columns order by total; beyond 12, a single-valued column field folds the rest into a "+N more" column that expands on click. No value sorts last as its own row or column. Headers sort the pivot only. Each cell is a button on one roving tab stop moved by arrow keys; an eligible cell opens the table filtered to it, and an ineligible one stays focusable with its reason. Phones keep the grouped list. A footer appears when a visible money column has numeric loaded values; it uses the server aggregate when present, otherwise labels loaded-row totals explicitly. The floating selection bar rises 8px in 180ms, keeps query controls visible, totals each visible loaded money column separately, and renders only the list's existing bulk actions, with its count, three primaries, a More overflow and Clear.

### Contact sheet

Every generic entity list offers Contact sheet in Display → Layout. It shares
Cards' list reader, grouping, search, filters, sorting, pagination and inspector.
Each record contributes only its resolved main image, in a fixed 32×32px square
with 1px gaps and no tile padding or captions. This explicitly requested contact
sheet density stays 32px on phones too; the other controls retain their normal
touch targets. Fit is the default and contains the complete image; Fill crops
it to cover the square. Hover and keyboard focus reveal the record name, and
activation opens the existing inspector. Modified link clicks retain normal
navigation. Image-less records leave no placeholder; the omission count explicitly
covers loaded records and updates as more pages arrive. Loading, errors, empty
results and the next-page sentinel retain the shared list lifecycle, even when
an entire loaded page has no images. Contact sheet and Fit/Fill are local to the
mounted screen, with no URL or saved-preference state.

### Data visualization

Data colors are independent of neutral interaction ink. The eight categorical
chart tokens use the existing blue, plum, teal, ochre, violet, terracotta, olive
and slate palette on the web's light surface. The shared sequential heat scale
runs from paper to blue, switching to paper ink on its deepest two fills. Spend-strip
bars, comparison glyphs and the cash-flow net line use these same data roles;
negative spend retains its semantic negative tone. Labels, axes and grid lines
remain neutral, with counts and text preserving meaning without color.

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
tree navigation and disclosure have no movement animation. Other disclosures
rotate their chevron and fade their body over 120ms, without animating height.

Share the visual grammar, never the domain arithmetic. Statistical charts (ranked bars, donuts, spend trends) use `ui/charts/kit.tsx` (`RankedBarBreakdown`, `CategoryDonut`, `SpendTrend`) with `lib/nivo-theme.ts`, `ChartTooltip`, and `Visualization`: one implementation of ranking, sizing, empty state, tooltip, keyboard-safe click, no-motion policy, and screen-reader summary. Nivo owns tooltip placement through `ChartTooltip`.

- **Money stays server-owned.** Filtered SQL aggregates preserve `SUM(Expense.cost)`, credits, null-date treatment, and principal spend versus adjustments. Signed monthly and ranked net bars keep refunds below zero; positive-only donut arcs show a true-net center; the trade x cost-type matrix is the corrective detail for negative nets that stacked bars cannot show.
- **Money reads to the cent.** Totals, summary strips, tooltips, matrix cells and screen-reader summaries format with cents so they reconcile against statements. Only axis ticks and labels painted inside a bar or arc may round to whole dollars.
- **Specialized renderers stay specialized** when the semantics differ: dependency graphs (directed edges, worker layout, transitive reduction, cycle checks), Gantt (date geometry, drag, dependencies), calendar heatmaps, nutrition bars (uncertain ranges), the recipe cost treemap, the unit-mapping graph, the ingredient network, the entity reference graph (a schema overview, not record traversal), location hierarchy views, product-category donut (count and drill-navigation), task status board, and operational layouts (calendar grid, task board, project tree). They may reuse `visualization.tsx` presentation and shared pivot helpers, not force-fit into the chart kit.
- **Graph workspace.** `/connections`, `/graph`, and detail-page relationship maps share `relationships/graph-explorer.tsx` (React Flow, incremental worker placement, viewport culling, retained camera). Compact 224px map nodes carry a 40px cover, identity, and two curated facts; selection opens the full eight-fact inspector. The inspector and minimap start closed. Many-record relationships are counted branch buttons, and only direct singleton relationships open automatically. Descendants and siblings stay hidden until their branch is expanded; Show wider network explicitly reveals the loaded branches, including siblings. Loading a record never grants visible expansion intent. The entity's preview roster owns the facts; canonical selected-field list readers supply prices, recorded spend, quantities, and progress in batches by entity kind. Never invent a card-specific money calculation. The focus sits at the center, relationship branches radiate around it, and descendants fan outward in their parent's direction. Existing positions and camera stay put during expansion. Fit focus frames the first ring at a minimum 85% zoom; manual zoom stops at 85%, and Collapse all returns to relationship summaries. Maps start at one link; deeper traversal and distant path search remain explicit. Fit map, a collapsible inspector, and a linked paths list support different densities. Direction arrows and relationship labels retain canonical edge ownership even when a path traverses backward. Selection inspects loaded facts; branch expansion is explicit; pages reveal 12 records at a time; one map holds at most 500 records and 1,000 connections. The depth picker supports one through four links without increasing those budgets. Destination-path search keeps its server bounds. `/connections` without a record offers a starting-record picker; existing view-specific URLs retain their connected-records table and offer the map. Recipe and work dependency views keep their own layout and adapters above the generic relationship read.
- **Connection context.** Detail headers and the connections workspace surface up to four populated curated connected views, with linked targets and expandable witnessed paths. A shared vendor or location is not purchase intent. Product purchase-project context follows the product's own Expenses to their assigned Projects; a mixed order must not assign a sibling line's Project to this Product. Multiple targets remain visible with the total count. Suggestions stay in their explicit review surface in the inspector and never become recorded graph edges before acceptance. Swift uses this same workspace directly on the global graph route and in a scoped full-screen presentation from record details; the old Swift graph and connection-review UI are removed.
- **Visualization presentation** uses `ui/visualizations/visualization.tsx`: explicit loading, empty, error and ready states. Initial errors show raw diagnostics and Retry. A ready state may carry an inline refresh error; the renderer stays mounted through failure and retry so camera, focus and selection survive. `visualizationState` reads only the current query's data/error; neither it nor the frame caches data. Query keys own entity/record/filter/date/order/page scope, and owners must not use previous-scope placeholder data. The component that owns the query (including expense analytics, entity timelines and location trees) supplies lifecycle state and Retry; a ready-only outer frame cannot substitute for query error handling. Hydration-gated owners keep loading visible until hydration completes. Optional portfolio Analytics retains its enabled query and lazy renderer gate.
- **Every chart** offers an accessible text alternative or summary, distinct loading, error, and empty states, and lazy-loads its renderer.
- **Hierarchy and network charts** use Nivo through the browser-only renderer boundary; application code does not import D3 directly. Network layout settles before rendering, with animation disabled. Trees use a scrollable viewport and linked labels. Expandable text lists expose ingredient pairs and their recipes, recipe row costs (with unpriced rows excluded from tile areas), and directed/self-referencing schema relationships. Unit graphs distinguish built-in conversion bridges with dashed links.

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
- **Don't** make desktop table rows taller than 24px or put a second line in an RTable cell.
- **Don't** use decorative cards, invented metrics, or unrelated placeholder illustrations to fill space.
- **Don't** trade readable text, visible focus, or phone touch targets for density.

### Decision steps

`DecisionSteps` is the interactive RecordList timeline, using RecordRow expanded detail and actions. Done uses a filled positive dot, blocked a faint point, not needed a hollow ring, and needs input a citron attention mark, never warning. Answered rows keep their summary inline and a quiet change disclosure: 28px on desktop, 44px phone targets. Only the open body is visible; hidden bodies stay mounted to preserve drafts and suggestion receipts. Opening a body moves focus into it. Optional 112px evidence media spans the rows on desktop and precedes them on phone. Callers supply steps and bodies; the component owns only disclosure.

### Photo inventory review

Photo review is an Operate workbench: a compact item list beside one selected
editor on desktop, stacked on narrow screens. Selection checkboxes belong to
batch approval; opening an item is independent. Arrow keys or J/K move between
item buttons, and visited editors remain mounted to preserve drafts.
The editor exposes Product details and the inventory decision directly, without
completed-step disclosures. Whole-item photos lead a compact gallery; label
photos stay adjacent and open the shared full-scene viewer. Raw label text,
descriptions and Claims live in the evidence disclosure beside those photos.
The run-wide Photos processing table is also disclosed, keeping repeated raw
analysis out of the review workspace.
Resolved brands use shared entity links in the item list, selected field and evidence;
new-brand proposals remain text until approval creates the record. Brand links in
the list sit outside the item-selection button. Brand evidence names the source-photo count, distinguishes existing-brand
selection from proposed brand creation, and records rejection in the proposal.
Evidence-matched bulk brand edits preview their exact new, unbranded Products;
member-reviewed groups, explicit choices and rejections remain untouched. Existing Product changes retain
Current/Proposed comparison and only selected fields apply.
Proposal saves never imply applied records. Individual and ready-item batch
approval show the Product and stock outcome; unresolved identity/grouping or
required destination decisions remain visible. Optional missing metadata carries
no false completion mark and does not block approval.
The review status line names the action that ran: a refused save keeps "Changes
were not saved", a refused approval or discard reads "Decision was not
applied", and pending approval counts the items actually approving.

### Derived values

`ui/derived` and `entity/fields/explanation` own the ADR 0021 envelope presentation. Own values carry no mark.
Inherited values have a muted leading ↳ in a 12px slot. An automatically set value
is a neutral chip with a small ochre sparkle; “Set automatically” is its tooltip
and accessible name. Refresh marks remain
visible independently of hover: queued, waiting and stale-unscheduled values
have a static info-tone dot with their distinct status label. A related refresh
pending has that same static dot and never reads as queued for this value. Only
an observed executing ticket with an unexpired Job lease pulses; reduced motion keeps it
static. A local timer expires that observation without fetching and labels its
status as potentially out of date. Failed values expose the raw
diagnostic on hover and keyboard focus. Missing values retain Not assessed or
the field's normal dash. Marks preserve the table row height.
An owed refresh's explanation shows its recorded trigger as a labelled fact;
older work without that metadata says Not recorded. Activity's existing
per-value disclosure lists the same trigger descriptions and their counts,
including the unknown bucket. Trigger text carries no record names or values.
A related refresh says it may not affect this value and its trigger reads Not
attributed to this value; it never names a precise record cause.

Why this value is one viewport-bounded popover: a vertical chain in declared
precedence order, with a filled deciding level and muted skipped levels. Set,
Use inherited, Accept and Reject belong to the affected level. Detail proposals
retain inline Accept. Pending suggestion evidence and review actions remain available
while the explanation query loads or fails; their enabled state follows the
current suggestion. Forms place inheritance and explicit None controls inside
Why this value. Structured resolution evidence renders the resolved rollup once,
using the same linked labels and inherited markers as ordinary field values;
contributor summaries retain their individual values. Wire reference keys stay
in technical details. Empty chains render their footer once,
and allocated results retain their Mixed or Allocated label. An allocated
result without a scalar value reads Allocated rather than Not set; its shares
remain the source of project amounts. Quality checks and their exception controls share this
explanation. Quality cards keep the explanation trigger available beside missing or failed results. Interpretations retain their readable result, caveats and next steps.
The footer compares stored and live values and shows the last computation,
observed execution start and known retry deadline: Next retry while it is ahead,
Retry was due once it has passed, and no claim when it is unknown. Unknown invalidation causes or finish times
remain unknown. Progress here is the phase and observed start time; no value has
a percentage, remaining count, ETA or queue position.
`ui/derived` holds the entity-independent marks and stacks; the explanation
popover that reuses entity links, evidence and existing mutation actions lives
in `entity/fields/explanation`.

Display image sources are read-only strips in precedence order, with a linked
source header and the chosen cover outlined. Header and table thumbnails open
the chain; the Images section also renders it. Both read the record-level
`fieldExplanation.imageChain` query and preserve its precedence order. Editing
remains #3310.
Remaining counts do not establish completed outcomes, a workload total or an ETA.
Current publications are shown by source and age window, without interpreting
their age distribution as an execution-event rate.
The Assessment producer and its internal-source observations are a separate
publication cutover; the additive DTO alone does not enable them.

Progress uses the shadcn `ui/primitives/progress.tsx` copy, extended with Cubby's
normalization and paused and indeterminate states, with
`ProgressLabel`, `ProgressValue`, and a 6px token-colored track. Labels and
values stack on phone widths so long Job kinds retain their own line. Run detail and
Run Work cells show the current phase's known processed/total counts;
unknown totals remain text. The derived backlog uses counts and observed states;
it has no completion bar based on queue depletion. The collapsed rail retains
its status dot. Client synchronization remains separate from execution progress.

### Activity and evaluation progress

Run Evaluation progress uses shared Progress labels and values for Records
checked and Evaluations settled. Paused and stopped Runs retain their counts
with a paused bar and suppress historical rates and remaining-time estimates.
Cancelled evaluations stay in the population denominator and appear in the
facts and record-kind table. Activity and Evaluation reads age on the shared
display clock independently of refetching: after three polling intervals,
cached observations show their measurement age and suppress live indicators,
pace and ETA. Derived backlog has no payload timestamp, so its successful read
time supplies the age. The minute display clock also refreshes on focus and wake.

Project attention uses one quiet shared completeness notice in its dashboard, Problems and Work surfaces, with singular-aware project counts and known-findings wording. Saved-view count pills contain numbers only; incomplete membership is explained in the tab title and shared list status strip. Missing Project task rollups display Updating… until publication.

### Work diagnosis and definitions

Work is one screen at the compatible `/activity` URL: an always-present health
line, a Stuck section only when something is stuck, and one Needs you queue,
then footer links to Suggestions, Missing facts, All work and History. No tabs,
no stat tiles and no intro. It answers two questions, whether background work is
healthy and what needs a member, and carries no scheduler or queue vocabulary:
no wakes, leases, tickets, deadlines, pace or refresh counts. Telemetry belongs
to `/jobs`, the Run and Job pages (direct link and command menu) and MCP.

The health line states one of Healthy, Catching up, Stuck or Unknown in a
sentence of secondary ink. It never shows a count of internal work, a percentage
or an ETA. A failed read says the page cannot tell, with raw diagnostics and Try
again, and never claims all clear. Stuck rows are flat with hairlines: a static
`warning-ink` glyph, an outcome title, one sentence on consequence or remedy, at
most one action, and a closed Technical details disclosure holding the raw failure
with Copy. Eight rows show initially; Show more reveals every remaining category
in place, and Show fewer restores the compact view. A retry reads every 10
seconds for two minutes, then the page goes quiet.

Needs you is the embedded `WorkQueue` grouped by Reason, over `NEEDS_YOU_FILTERS`
(mine plus shared, optional proposals excluded): one population with the sidebar
and Home's preview. With nothing to show the page reads `Nothing needs you.` at
its largest size. While inputs are incomplete it keeps the queue's known-work
notice instead, because an unknown source cannot be claimed empty. Work, the full
queue and Home share that notice: one quiet line naming how many checks are
updating, with each check's declared label and extent behind its disclosure.
Source and Problem keys never reach the member.

The sidebar's Work row shows the needs-you count and, only when something is
stuck, a static warning glyph; the collapsed rail shows one dot with the same
label. Citron is never a warning. Healthy work shows nothing at any backlog size,
and a failed read stays silent because the page itself reports it. The read never
polls. History is a thin `/history` route of Run history and recorded Changes.

Run types is the permanent “What does each Run do?” reference. Definitions
lead with targets, exclusions, possible effects, dependencies, cost and recovery.
Ordered steps reuse declaration labels and purpose text from live execution;
static definitions forecast possible work; actual Run/Job evidence remains
canonical. Counted inputs freeze at step start, estimates retain their qualifier,
and tallies have no implied total.
Execution drivers and ownership details stay behind a technical disclosure.
Job definitions share the canonical kind-policy declaration, and Job/Run headers
link to their definitions. Historical types remain distinct.

Settings → Maintenance holds the daily pass and repair tools behind a closed
disclosure, so opening Settings reads no maintenance status. It explains the
standard daily 7 a.m. household pass before its Run now action; internal daily
queue upkeep has its own Job definition. Backlog
and image classification counts sit behind disclosure. Image classification
rows can overlap and uncertain cutout eligibility is not a review queue.
Recipe re-parsing and alias pruning require an explicit successful preview
before Apply; each bounded Current/Proposed sample states its coverage and that
the server rechecks current eligibility rather than locking the preview population.

Expanded repair comparisons span the available width below
the description and action controls; comparison content never competes with
the description for a narrow right-hand column.

Idle operational views do not poll the database.
