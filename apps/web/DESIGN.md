---
name: Cubby
description: A warm-paper household operating ledger for food, inventory, projects, and spend.
colors:
  ink: "#16170f"
  ultramarine: "#2244cc"
  ultramarine-dark: "#16308f"
  paper-surface: "#fcfaf4"
  paper: "#f7f4ec"
  paper-alt: "#efeae0"
  hairline: "#d8d2c4"
  shelf: "#6b6658"
  aubergine: "#7a3f63"
  positive: "oklch(0.5 0.1 150)"
  warning: "oklch(0.62 0.13 65)"
  warning-ink: "oklch(0.5 0.13 65)"
  destructive: "oklch(0.45 0.18 25)"
  slate: "oklch(0.5 0.008 80)"
typography:
  display:
    fontFamily: "Space Grotesk Variable, Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: "2.25rem"
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Space Grotesk Variable, Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Space Grotesk Variable, Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: "1.5rem"
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1.21875rem"
    letterSpacing: "normal"
  body-prose:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    letterSpacing: "normal"
  data:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, SF Mono, Monaco, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
    letterSpacing: "normal"
  label:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, SF Mono, Monaco, Consolas, monospace"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: "0.875rem"
    letterSpacing: "0.05em"
rounded:
  square: "0"
  circle: "9999px"
spacing:
  tight: "0.125rem"
  xs: "0.25rem"
  snug: "0.375rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  wide: "2rem"
  section: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.ultramarine}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.square}"
    padding: "0 0.5rem"
    height: "1.75rem"
  button-primary-hover:
    backgroundColor: "{colors.ultramarine-dark}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.square}"
    padding: "0 0.5rem"
    height: "1.75rem"
  button-outline:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.square}"
    padding: "0 0.5rem"
    height: "1.75rem"
  input:
    backgroundColor: "rgb(239 234 224 / 0.2)"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.square}"
    padding: "0.125rem 0.5rem"
    height: "1.75rem"
  badge-primary:
    backgroundColor: "rgb(34 68 204 / 0.1)"
    textColor: "{colors.ultramarine}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0.125rem 0.375rem"
    height: "1.25rem"
  card:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.square}"
    padding: "0.625rem 0.875rem"
  navigation-active:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.square}"
    padding: "0 0.5rem"
    height: "2rem"
  table-header:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.slate}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 0.5rem"
    height: "2.5rem"
  detail-spec-plate:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.headline}"
    rounded: "{rounded.square}"
    padding: "0.75rem 1rem"
---

# Design System: Cubby

## Overview

**Creative North Star: "Warm-Paper Ledger"**

Cubby should feel like a working household record carried between pantry, workshop, and desk. It applies print-editorial discipline to a data-dense operating tool: matte paper, crisp ink, compact typography, ruled regions, and information arranged to be scanned while someone is doing real work. The result is practical, exacting, and lived-in rather than polished for a sales demo.

Components are **flat, ruled, and instrument-like**. Hierarchy comes from typography, paper tone, hairline division, and a small number of heavy ink rules—not from floating cards or theatrical whitespace. Dense screens should resemble control sheets, catalogs, and ledgers whose structure becomes clearer as information accumulates.

The visual anti-reference is the glossy SaaS dashboard: no glass, glow, gradient-filled surfaces, dark control-room canvas, soft lifestyle sentimentality, or generic enterprise card stacks. Cubby remains warm without becoming decorative, and technical without becoming sterile.

**Key Characteristics:**

- Warm matte paper surfaces with near-black ink.
- High information density and compact, repeatable rhythm.
- Square geometry, hairline borders, and signature 3px ink rules.
- One loud interactive ultramarine used with restraint.
- Space Grotesk headings, Inter prose, and JetBrains Mono data.
- Flat charts and tables that favor comparison over spectacle.

## Colors

The palette is ink and warm paper first, with Live Ultramarine reserved for interaction and the most important current value.

### Primary

- **Live Ultramarine** (`#2244cc`): Primary actions, focus, active navigation, selection, links, and the single live value that should command attention.
- **Deep Ultramarine** (`#16308f`): Hover state for filled primary actions; it deepens the same voice rather than adding another accent.

### Secondary

- **Recipe Aubergine** (`#7a3f63`): Reserved identity color for recipes and cookbooks. It distinguishes the cooking domain without competing with interaction blue.

### Neutral

- **Ink** (`#16170f`): Primary text, heavy dividers, the 3px control-sheet rule, and strong silhouettes.
- **House Paper** (`#f7f4ec`): The base canvas.
- **Paper Surface** (`#fcfaf4`): Panels, headers, popovers, and sticky chrome that sit one tonal step above the canvas.
- **Inset Paper** (`#efeae0`): Zebra rows, muted regions, neutral hover states, and secondary controls.
- **Hairline** (`#d8d2c4`): Borders, dividers, table grids, and quiet structural separation.
- **Shelf Ink** (`#6b6658`): Secondary prose and supporting labels.
- **Slate Mark** (`oklch(0.5 0.008 80)`): Mono micro-labels, eyebrows, neutral stamps, and quiet entity accents.

### Semantic

- **Positive** (`oklch(0.5 0.1 150)`): Success, availability, and positive money states.
- **Warning** (`oklch(0.62 0.13 65)`): One consistent amber warning voice, tuned
  for fills, tints, borders, and marks.
- **Warning Ink** (`oklch(0.5 0.13 65)`): The same amber at reading lightness —
  the warning above is 3.6:1 on paper, so anything the amber voice has to *say*
  (not just mark) uses this instead. One step down the warning ramp; no new hue.
- **Destructive** (`oklch(0.45 0.18 25)`): Errors and destructive actions, generally as text, border, or a restrained tint rather than a saturated block.

### Named Rules

**The One Loud Thing Rule.** Live Ultramarine is the loudest color on the screen and should identify an action, active state, focus, or one live value—not decorate every panel.

**The Paper, Not Glass Rule.** Separate with paper tone and ink rules. Do not introduce glow, translucent glass, surface gradients, or chromatic shadows.

Categorical hue is exceptional. The project Gantt may use its established muted six-family phase palette because twenty trades need a grouping channel; ordinary screens use the ink ladder, semantic tones, and Live Ultramarine.

## Typography

**Display Font:** Space Grotesk Variable (with Space Grotesk and system sans fallbacks)  
**Body Font:** Inter Variable (with Inter and system sans fallbacks)  
**Label/Mono Font:** JetBrains Mono Variable (with SF Mono, Monaco, and Consolas fallbacks)

**Character:** Space Grotesk gives headings compact geometric authority, Inter keeps small interface prose highly legible, and JetBrains Mono makes quantities, codes, dates, and metadata feel like entries in a real working record. The three voices are functional roles, not decorative alternates.

### Hierarchy

- **Display** (700, `1.875rem/2.25rem`, `-0.025em`): Large detail names and the highest-emphasis page identity.
- **Headline** (700, `1.5rem/2rem`, `-0.025em`): Standard list-page headings and compact heroes.
- **Title** (700, `1rem/1.5rem`, `-0.025em`): Dialog titles and bounded panel headings that need more authority than an eyebrow.
- **Body** (400, `0.75rem/1.21875rem`): Dense controls, tables, cards, and operational UI.
- **Body Prose** (400, `0.875rem/1.25rem`): Explanations, empty states, and passages that need continuous reading.
- **Data** (400, `0.75rem/1rem`): Quantities, money, dates, codes, metrics, and cells; use tabular numerals where columns compare.
- **Label** (500, `0.625rem/0.875rem`, `0.05em`, uppercase): Eyebrows, table headers, categorical stamps, and micro-labels.

### Named Rules

**The Three Voices Rule.** Space Grotesk names, Inter explains, and JetBrains Mono measures. Do not use the mono face as a novelty display font or the heading face for dense data.

Readable text has three solid hierarchy tones: Ink for primary, Shelf Ink for secondary, and Slate Mark for mono micro-labels. Opacity is for surfaces and state tints, not for inventing additional tiers of prose.

## Layout

Cubby is an Operate-mode interface: scanning, comparison, and task completion outrank presentation. Desktop uses a persistent 56px rail that can expand to 224px, a 48px command header, and a content area with `0.5rem` phone gutters or `1.5rem` desktop gutters. Ordinary pages cap at `80rem`, expanding to `90rem` on very large displays; intentionally wide working surfaces may opt out.

The spacing rhythm is closed and deliberate. Repeated layout uses named primitives: `Row`, `Stack`, `Grid`, and `Section`. The core gaps are `0.25rem`, `0.5rem`, `1rem`, and `1.5rem`; the sanctioned dense sub-steps are `0.125rem` and `0.375rem`. Larger `2rem`, `3rem`, `4rem`, and `5rem` steps are reserved for page gutters, clearance, and major regions. Density should come from aligned rows and compact controls, not arbitrary one-off compression.

Cards and panels are bounded regions, not a universal list item. Repeated records use bordered or zebra-striped rows. Responsive grids collapse from two or three desktop columns to one column; thumbnail grids retain multiple columns where the imagery remains legible. On phones, controls rise to roughly 40–48px touch targets, the top masthead and bottom navigation remain fixed, and safe-area insets are respected.

## Elevation & Depth

The system has no resting elevation. Cards, popovers, dialogs, sticky chrome, and tables are flat paper surfaces; separation comes from tonal steps, hairline borders, zebra bands, entity spines, and the signature 3px ink rule. The scanner’s large dark viewfinder scrim is a functional exception, not a general shadow vocabulary.

Motion is short and mechanical: most state transitions settle in `100ms` with `cubic-bezier(0.2, 0, 0, 1)`, while the collapsible desktop rail uses `150ms`. There is no bounce or overshoot. Reduced-motion preferences neutralize animations and transitions.

### Named Rules

**The Flat-by-Construction Rule.** If a surface needs separation, add a real rule or change its paper tone. Never reach for a drop shadow to repair weak hierarchy.

## Shapes

The default radius is `0`: buttons, inputs, cards, menus, dialogs, badges, tooltips, navigation states, and stamps are square. This gives the interface the geometry of labels, ruled forms, and cut paper rather than a collection of soft app tiles.

Circular geometry is reserved for things that are inherently circular, such as loading spinners or image/avatar crops when the content calls for it. Ink stamps may rotate by approximately two degrees, but their corners remain square. Strong entities and detail plates may use a 6px left spine; major headers and table bands use a 3px rule.

## Components

Components should feel flat, ruled, and instrument-like: compact enough for real household data, explicit in state, and built from the same paper-and-ink vocabulary.

### Buttons

- **Shape:** Square (`0` radius), 1px boundary where the variant needs one, compact default height of 28px.
- **Primary:** Live Ultramarine with white text; use for the surface’s leading action, not every available action.
- **Hover / Focus:** Primary deepens to Deep Ultramarine. Focus uses a crisp two-ring ultramarine treatment; press slightly reduces opacity. Transitions use the 100ms mechanical settle.
- **Outline / Secondary / Ghost:** Paper Surface, Inset Paper, or transparent at rest; hairline borders distinguish outline and secondary variants. Hover moves one paper tone darker.
- **Destructive:** Deep red text and restrained red tint with a real border; avoid a large saturated red slab unless the action truly demands it.

### Chips

- **Style:** Badges are square rubber stamps: `10px` JetBrains Mono, uppercase, tracked, 1px border, and a roughly 10% semantic tint.
- **State:** The border and text carry the category; the background remains quiet. Free-form human prose opts back into Inter, normal case, and normal tracking.

### Cards / Containers

- **Corner Style:** Square.
- **Background:** Paper Surface over the House Paper canvas.
- **Shadow Strategy:** None.
- **Border:** 1px Hairline; use a 3px ink top rule or 6px entity/detail spine only when stronger structure is warranted.
- **Internal Padding:** Typically `0.625rem` vertically and `0.75–0.875rem` horizontally, with `0.5rem` internal rhythm.

### Inputs / Fields

- **Style:** Square, 1px Hairline, faint Inset Paper background, compact 28px desktop height, and 40px phone height.
- **Focus:** Border shifts to Live Ultramarine with a crisp 2px ring; never glow.
- **Error / Disabled:** Destructive border and restrained ring for invalid state; disabled state uses reduced opacity and blocks interaction.

### Navigation

Desktop navigation is a flat Paper Surface rail divided by hairlines. Expanded groups use mono uppercase eyebrows; leaf links use compact Inter labels and 14px icons. Active items use House Paper, a Hairline border, and Ink rather than a pill. The 48px sticky command header ends with a 3px Ink rule.

Phone navigation is a fixed Paper Surface bar with a 3px Ink top rule and 48px minimum targets. Active tabs use Live Ultramarine and a square top marker—no bouncing icon, floating capsule, blur, or translucency.

### Tables

Tables are the primary high-density record surface. Headers use Paper Surface, uppercase mono labels, and a 3px Ink underline. Rows use hairline division and optional Inset Paper zebra tone. Selection adds a faint ultramarine wash plus a 3px inset accent spine. Numerals align with JetBrains Mono and tabular figures.

### Detail Spec Plate

The signature detail header is a ruled Paper Surface placard with a 6px Ink left spine. It combines a mono breadcrumb and shortcode, a Space Grotesk entity name, optional sparse Ink Stamp, actions, and a hairline-divided strip of mono metrics. It should read like a catalog plate attached to the record, not a marketing hero.

## Do's and Don'ts

### Do:

- **Do** use paper tone, Hairline borders, and 3px Ink rules to establish hierarchy.
- **Do** reserve Live Ultramarine for action, focus, selection, active navigation, and one important live value.
- **Do** use Space Grotesk for names, Inter for explanation, and JetBrains Mono for measurements and codes.
- **Do** build dense repeated information as aligned rows, tables, or matrices.
- **Do** use the named layout primitives and closed spacing rhythm for repeated structures.
- **Do** preserve 40–48px phone controls and safe-area-aware fixed chrome.

### Don't:

- **Don't** add drop shadows, glass blur, glow, surface gradients, dark dashboard chrome, or neon accents.
- **Don't** turn repeated records into stacks of airy padded cards.
- **Don't** round ordinary controls, panels, navigation states, badges, or dialogs.
- **Don't** use Live Ultramarine as general decoration or introduce competing arbitrary blue shades.
- **Don't** invent a fourth text hierarchy tier with opacity; use Ink, Shelf Ink, or Slate Mark.
- **Don't** use raw red, green, amber, or yellow utilities when the semantic Positive, Warning, or Destructive tokens express the meaning.
- **Don't** shrink phone controls to desktop density or disable pinch zoom.
