---
name: Cubby
description: A light-mode household transit system for dense records, truthful relationships, and task-focused workbenches.
colors:
  porcelain-canvas: "#f7f9fc"
  surface: "#ffffff"
  inset: "#f1f4f8"
  graphite: "#171a21"
  graphite-secondary: "#667085"
  hairline: "#d9dee7"
  cobalt: "#2563eb"
  cobalt-hover: "#1d4ed8"
  on-accent: "#ffffff"
  cook-saffron: "#d97706"
  pantry-green: "#16845b"
  plan-violet: "#6d5bd0"
  house-cyan: "#147d92"
  finance-magenta: "#b5477c"
  positive: "#16845b"
  warning: "#b66a00"
  warning-ink: "#8a4f00"
  destructive: "#c93636"
typography:
  display:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: "2.25rem"
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    letterSpacing: "normal"
  body-control:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1.125rem"
    letterSpacing: "normal"
  data:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, SF Mono, Monaco, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
    letterSpacing: "normal"
  label:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: "0.875rem"
    letterSpacing: "normal"
rounded:
  control: "6px"
  panel: "8px"
  chip: "5px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body-control}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.cobalt-hover}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body-control}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.graphite}"
    typography: "{typography.body-control}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.graphite}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "36px"
  status-chip:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
    height: "20px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.graphite}"
    typography: "{typography.body}"
    rounded: "{rounded.panel}"
    padding: "12px 14px"
---

# Design System: Cubby

## Overview

**Creative North Star: “Porcelain Transit”**

Cubby is household operating software: records are stations, verified
relationships are routes, and workbenches move a person from attention to
evidence to action. Porcelain-white planes and cool structural grays keep dense
data calm; graphite typography carries hierarchy; cobalt identifies
interaction; five stable domain lines make the application navigable without
coloring every row.

Information density is asymmetric by design. Read-heavy desktop grids are
ultra-dense, while forms, dashboards, detail content, and phone flows retain
normal breathing room and 44px interaction targets. Selection opens context
without losing place: a docked inspector on wide desktop, a right sheet at
intermediate widths, and the complete canonical detail route on phone.

The anti-references are the nostalgic paper ledger, Win32 styling, dark control
rooms, generic KPI-card dashboards, decorative relationship graphs, and glossy
SaaS surfaces. The application may feel technical, but never synthetic or
theatrical.

**Key Characteristics:**

- Light-only Porcelain canvas, white working planes, graphite type, cool rules.
- Dense 28px read-heavy grids; normal-density content everywhere else.
- Cobalt interaction plus five expressive, stable domain lines.
- Truthful direct relationships before derived evidence.
- Compact wide-desktop inspection and native-feeling phone routes.
- Fine borders, modest radii, and purposeful spatial motion only.

## Colors

The neutral planes carry most of every screen. Cobalt answers “what can I do?”;
domain colors answer “where am I?”; semantic colors answer “what condition is
this in?” These channels must not be substituted for one another.

### Primary

- **Transit Cobalt** (`#2563eb`): primary actions, links, focus, selection, the
  active route, and the current relationship path.
- **Deep Cobalt** (`#1d4ed8`): hover treatment for filled cobalt controls.

### Secondary

- **Cook Saffron** (`#d97706`), **Pantry Green** (`#16845b`), **Plan Violet**
  (`#6d5bd0`), **House Cyan** (`#147d92`), and **Finance Magenta** (`#b5477c`):
  stable domain wayfinding for navigation, page identity, entity marks,
  selection context, relationships, and relevant chart series.

### Tertiary

- **Positive** (`#16845b`), **Warning** (`#b66a00` with `#8a4f00` reading
  ink), and **Destructive** (`#c93636`): condition only, always paired with
  text, shape, or an icon.

### Neutral

- **Porcelain Canvas** (`#f7f9fc`): application background and quiet spatial
  separation.
- **Surface White** (`#ffffff`): tables, cards, inspectors, sheets, popovers,
  and sticky chrome.
- **Cool Inset** (`#f1f4f8`): hover, zebra rows, muted controls, and grouped
  subregions.
- **Graphite** (`#171a21`): primary text and icons.
- **Secondary Graphite** (`#667085`): supporting text and quiet metadata.
- **Hairline** (`#d9dee7`): borders, dividers, grids, and resting boundaries.

### Named Rules

**The Three Channels Rule.** Interaction, domain identity, and status each have
their own color channel. A green Pantry route is not a success state.

**The Calm Grid Rule.** Large table backgrounds stay neutral. Color belongs on
small marks, selected context, meaningful series, and real state—not every cell.

## Typography

**Display / Body Font:** Inter Variable, with Inter and system sans fallbacks.
**Data Font:** JetBrains Mono Variable, with platform mono fallbacks.

**Character:** Inter makes compact operational prose read cleanly at many
densities; weight, size, and spacing establish hierarchy without a decorative
heading face. JetBrains Mono is functional alignment for measures and codes,
not a technical costume.

### Hierarchy

- **Display** (600, `30/36px`, `-0.025em`): the largest detail identity only.
- **Headline** (600, `24/32px`, `-0.02em`): page identity and major regions.
- **Title** (600, `14/20px`): panels, dialogs, cards, and inspector sections.
- **Body** (400, `14/20px`): explanations and continuous reading, ideally
  `65–75ch`.
- **Control / Dense body** (500/400, `12/18px`): desktop controls and table
  rows; ordinary page prose must not collapse to this density.
- **Data** (400, `12/16px`): quantities, money, dates, shortcodes, and aligned
  comparison values, with tabular numerals.
- **Label** (500, `10/14px`): compact metadata. Sentence case is the default;
  uppercase tracking is reserved for true codes or established data-register
  labels, never generic hierarchy. The detail breadcrumb (domain / plural /
  code) is a data-register label and keeps the eyebrow.

### Named Rules

**The Two Voices Rule.** Inter speaks; JetBrains Mono measures. Hierarchy comes
from role and weight, not swapping typefaces.

## Layout

Wide desktop uses a 208px expanded domain rail or 56px collapsed rail, a 48px
command band, a central work surface, and an optional 400px modeless inspector
at 1280px and wider. From 768–1279px, the same inspector content moves into an
explicit right sheet. Below 768px, rows use semantic cards or purpose-built
projections and navigate to complete detail routes; desktop inspectors do not
squeeze into the phone viewport.

Repeated layout uses a 4/8/12/16/20/24px rhythm. Ordinary content uses 12–16px
internal gaps and readable grouping. Read-heavy desktop tables target 28px rows
and 32px headers with 8px horizontal cell padding; editable or multiline rows
may rise to 32–40px. First visits default to dense only for explicitly
registered read-heavy rosters; a stored user density preference always wins.

Phone controls and links provide at least 44×44px targets. Fixed chrome respects
safe-area and virtual-keyboard insets. Normal pages never overflow the viewport;
wide grids, matrices, print sheets, and relationship strips may scroll inside
their own named region. Specialist layouts keep the task model that makes them
useful: calendar, Gantt, camera, arrange, reconciliation, and matrices are not
flattened into generic cards.

The signature relationship composition shows direct evidence first, derived
evidence second, explicit counts, bounded previews, canonical links, and source
provenance. It never invents a chain merely to make a prettier diagram.

## Elevation & Depth

Resting application surfaces have no shadow. Depth comes from the Porcelain
canvas, white working planes, inset tone, and 1px hairlines. Popovers, menus,
dialogs, and sheets may use the single restrained overlay shadow
`0 8px 24px rgb(23 26 33 / 0.12)` because they temporarily occupy another
interaction plane. Scanner scrims and sticky-column edge shadows are functional
exceptions, not a general visual vocabulary.

Motion is immediate for high-frequency table operations. Spatial overlays and
toasts use 120–180ms transform/opacity transitions with
`cubic-bezier(0.2, 0, 0, 1)`. Ambient motion is welcome where it says work
is in flight: small `loading-dev` indicators sized to the glyph they stand in
for. No spring overshoot, rolling values, or chart-drawing theater.
Reduced-motion preferences reduce transitions to effectively instantaneous
state changes.

### Named Rules

**The Resting Plane Rule.** If a resting surface needs separation, use tone or a
hairline. Shadow is reserved for a temporary overlay plane.

## Shapes

Controls use a 6px radius; panels use 8px; compact non-status chips may use 5px.
Full pills are reserved for inherently compact statuses or segmented choices.
Avatars, dots, and circular progress remain circular because their content is
inherently round.

Boundaries are normally 1px. A 2px boundary is allowed only where it carries a
specific interaction or data meaning, such as a pinned-column separator,
current-day marker, open-ended Gantt edge, text-diff underline, or selected
relationship column. Nutrition labels retain their conventional heavy rules.
Do not use thick colored side tabs on cards, alerts, or generic sections.

## Components

Components are compact, explicit, and composed from shared primitives rather
than route-local visual systems.

### Buttons

- **Shape:** 6px radius, 1px boundary where the variant needs one.
- **Size:** 32px default desktop, 28px compact desktop, 40px large; shared
  controls grow to at least 44×44px below the desktop shell breakpoint.
- **Primary:** Transit Cobalt with white text, reserved for the leading action.
- **Hover / Focus:** filled cobalt deepens; focus uses a crisp cobalt 2px ring
  and real boundary, never glow.
- **Outline / Secondary / Ghost:** white, inset, or transparent at rest with a
  neutral hover tone. Destructive actions use a restrained red tint and border
  with neutral foreground text so the warning remains legible on paper.

### Chips

- **Style:** compact status pills use 10px text, a 1px semantic border, and a
  quiet tint. They pair color with readable wording.
- **State:** selection chips may use cobalt; domain identity remains a separate
  mark. Free-form prose stays sentence case in Inter.

### Cards / Containers

- **Corner Style:** 8px panel radius.
- **Background:** Surface White over Porcelain Canvas.
- **Shadow Strategy:** none at rest.
- **Border:** 1px Hairline; domain or status may color a single hairline when it
  carries real meaning.
- **Internal Padding:** generally 12–16px; repeated records prefer rows over
  nested cards.
- Fact-grid labels are sentence-case secondary text, not eyebrows.

### Inputs / Fields

- **Style:** white surface, Hairline border, 6px radius, 36px desktop height,
  44px phone height, and 16px phone text where needed to prevent browser zoom.
- **Focus:** cobalt border plus crisp 2px ring.
- **Error / Disabled:** destructive border/ring for invalid state; disabled
  state visibly blocks interaction without becoming unreadable.
- Labels are sentence case at every width.

### Navigation

Desktop navigation groups Cook, Pantry, Plan, House, and Finance using stable
domain marks on a quiet white rail. Active routes use a neutral inset and domain
context rather than a floating pill. Phone navigation keeps five reachable
destinations, safe-area ownership, and contextual back behavior.
Navigation history is session-only. Do not persist the last visited page or add
a Resume destination across launches; resumable domain workflows such as an
inventory recount own their separate progress contracts.

### Tables and inspectors

The generic detail and list pages are built against the
[generic-page design canvas](https://claude.ai/artifact/A45j5qz24RjRK6KzKmKLWL):
hero plate, section kinds, workbench band, and journal variant. Check a
generic-page change against it.

A list's workbench is one 44px band: identity, declared views, search, one
chip per declared filter, More, Clear, Actions, create.

RTable owns dense record work: virtualization, pinned/resizable/reorderable
columns, saved layouts, selection, clipboard, grouping, editing, and aggregate
footers must survive styling changes. Wide desktop selection may open a 400px
modeless inspector with Overview, Relations, and Activity. Intermediate widths
use a sheet. Phone rows open the canonical detail route.

Row inspection and checkbox selection are separate contracts. A row click makes
one record current without selecting it for a batch. Checking exactly one
canonical record exposes Inspect first in the selection bar; it adopts that
record in the desktop dock or intermediate Sheet and navigates to canonical
detail on phone. Inspect disappears for multi-selection. Synthetic, projected,
tree-child, route-less, and embedded-ledger rows never impersonate canonical
records to gain this affordance.

Inspectors answer in one order: human identity, decision-relevant truth already
present in the detail payload, a bounded direct-relationship strip, then nearby
safe actions and supporting evidence. Product may keep richer authored
relationships, but it shares the same hierarchy and never issues a duplicate
relationship request. Reusable entity actions have one canonical verb,
availability rule, arity, ordering, and destructive treatment across row,
selection, inspector, detail, and palette surfaces; specialist workflow and
subresource operations remain local.

## Do's and Don'ts

### Do:

- **Do** keep tables dense and the rest of the product at normal density.
- **Do** use the five domain lines consistently for navigation and identity.
- **Do** show direct relationships before derived evidence and label provenance.
- **Do** distinguish loading, empty, error, permission, disabled, and offline
  states with a truthful next action.
- **Do** preserve 44px phone targets, safe areas, keyboard behavior, and bounded
  internal scrolling.
- **Do** use sentence case and the product’s real household terminology.

### Don't:

- **Don't** revive warm-paper colors, square rubber-stamp geometry, 3px ink
  rules, Space Grotesk headings, or heavy entity spines.
- **Don't** copy Win32 styling, dark control-room chrome, glass, glow, surface
  gradients, hard-offset shadows, or decorative animation.
- **Don't** turn every section or record into an equal-weight card.
- **Don't** use a domain hue as status, or red for anything except destructive
  and error meaning.
- **Don't** make non-table surfaces globally dense or squeeze desktop grids into
  phone viewports.
- **Don't** invent relationships, inventory automation, spend metrics, or
  multi-user coordination that Cubby does not maintain.
