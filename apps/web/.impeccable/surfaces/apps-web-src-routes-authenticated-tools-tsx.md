---
version: 1
slug: "apps-web-src-routes-authenticated-tools-tsx"
primary_target: "apps/web/src/routes/_authenticated/tools.tsx"
related_targets: ["apps/web/src/app/tools/tool-gallery-page.tsx","apps/web/src/app/projects/tool-matrix-page.tsx"]
---

# Tools workbench surface brief

## Job and mode

Tools is the House workbench for finding a physical tool and understanding where it lives, how much is present, and whether its project-use history justifies its cost. It is an Operate-mode surface: compact, scan-friendly, and durable rather than editorial.

## Visual composition

Use Porcelain Transit: white working planes, cool hairlines, House-cyan wayfinding, cobalt interaction, and square photo-led cards. The composition is a Tool Wall without literal pegboard, workshop cosplay, shadows, gradients, or decorative texture. Group headings are quiet ruled dividers; product photography carries most of the visual weight.

## Topology

The canonical route is `/tools`. Gallery is the default view and Usage is the existing project by tool matrix. The workbench header keeps the Gallery and Usage switch stable while each renderer owns its URL-backed controls. Gallery search and grouping do not alter Usage filters; Usage filters remain preserved when switching views.

Gallery groups expose a sticky, URL-backed section navigator below the gallery controls. Compact group rosters show every destination directly with its count; long rosters reuse Cubby's searchable single-value filter combobox with count hints. Choosing a destination loads any intervening 60-card pages and lands the section heading below the pinned navigator. This remains a jump affordance, never a filter: the full grouped result stays present.

## Truthful data constraints

One card represents one live Product categorized as tools, never one inventory row. Multiple live placements collapse into one card. Installed and stock placements both count. Every displayed amount remains attached to its own placement; incompatible units are disclosed as mixed and are never summed. A single placement shows its complete root-first location path and groups under its first household area. Multiple live locations group under Multiple locations. Unspecified manufacturers and unclassified trades are terminal groups. Project use count and cost per project use reuse the established project economics definitions and disappear rather than inventing values when no use exists.

## Card contract

Cards keep a square cover region, wrench fallback, extra-image count, product identity, manufacturer/model, compact placement paths and amounts, installed state, use count, and optional cost per use. Heights stay uniform inside a responsive two-to-six-column grid. The complete card is one focusable selection target with a visible cobalt focus treatment.

Density increases early without compromising phone legibility: two columns below 480px, then three, four, five, and six columns at the 480px, 768px, 1024px, and 1280px thresholds. Card-body padding stays compact while all truthful placement and economics fields remain visible.

## Responsive inspection

At desktop widths selection opens the existing Product inspector in a dock. At intermediate widths it opens the same inspector in a sheet. On phone, selection navigates to the canonical Product detail route. Phone controls and cards retain at least 44px targets; no compressed second inspector is introduced.

## Required states

Preserve loading skeletons, a quiet transition state, retryable first-page and load-more errors, no-inventoried-tools, no-search-results, missing-image fallback, mixed-amount disclosure, installed-placement labeling, and paginated loading. The Usage matrix remains functionally unchanged.
