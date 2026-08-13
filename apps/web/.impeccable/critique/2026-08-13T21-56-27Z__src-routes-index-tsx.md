---
target: the homepage
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-13T21-56-27Z
slug: src-routes-index-tsx
---
Method: dual-agent (A: design review · B: detector + browser evidence)

> Real household values are redacted in this snapshot (`<total>`, `<location>`, `<N>`)
> because `.impeccable/` is tracked in a public repo. The chat report carried the
> actual figures.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | `LazyMount` defaults to 200px reserve against 400–500px panels; page grew ~1,800px as Insights mounted. No `aria-live`/`aria-busy` on 8+ skeleton regions. |
| 2 | Match System / Real World | 3 | "Pantry value" labels a whole-house total whose top locations are workshop/garage, not pantry. An `UNKNOWN` location name ships to the page. |
| 3 | User Control and Freedom | 2 | The problems banner cannot be dismissed, snoozed, or filtered. No panel collapses, reorders, or hides. |
| 4 | Consistency and Standards | 2 | 5 `rounded-md`/`rounded-lg`/`rounded-full` against the radius-0 rule; 9 `<button>` nested in `<a>`; card titles are `<div>`; card title casing mixes Title Case and sentence case. |
| 5 | Error Prevention | 3 | Every card has a real `isError` branch, but all say the same unactionable "… is unavailable right now." with no cause and no retry. |
| 6 | Recognition Rather Than Recall | 2 | Activity feed renders entity *type + shortcode*, never the name. Chart labels truncate to 4 characters. Nav and tiles are well labeled, which keeps this off a 1. |
| 7 | Flexibility and Efficiency | 2 | 59 tab stops in `main`. Quick Actions is 8 *creation* forms on a mature database; the daily verbs are recount and look up. Nothing configurable. |
| 8 | Aesthetic and Minimalist Design | 1 | 5 regions, 17 stat tiles, 8 cards, 4 heavy charts, ~3,700–4,700px tall, **0px clearance between every top-level region**, and a footer restating counts already on the page. |
| 9 | Error Recovery | 2 | The problems count carries no category, severity, or top offender, and is permanently red. |
| 10 | Help and Documentation | 2 | Panel descriptions do real work, but nothing explains what a "problem" is, or why a third-party reference-table count sits in "Current position". |
| **Total** | | **21/40** | **Acceptable — significant improvements needed** |

## Design Specificity Verdict

**Partly authored — Cubby's materials, a stock dashboard's composition.**

The *materials* are unmistakably Cubby. `EntityCount` is a hairline-ruled ledger
strip with negative-margin edge de-duplication, mono tabular numerals over
eyebrow labels, and no card chrome — the Warm-Paper Ledger executing exactly as
DESIGN.md describes. Copy is household-native.

The *composition* is not authored. Strip the styling and the order is the default
admin-home shipping order: greeting → alert → two KPI cards → count strip →
activity + quick actions → charts. Nothing in that sequence argues about what
matters in a household. The tell is the code's own comment: the four Insights
panels were "folded in from the retired /insights page" — a whole page appended
because it had nowhere else to go, now ~55% of page height and the least
actionable content on the surface.

DESIGN.md promises a **control sheet** whose "structure becomes clearer as
information accumulates." A control sheet has registration. This page has **zero
pixels between all five top-level regions**, so structure does the opposite of
the stated north star.

PRODUCT.md's first north star — "What can I cook tonight, and what would it
cost?" — is answered nowhere on this page. It is a 14px mono link at the bottom
of the fifth card.

**Deterministic scan:** the source detector returned a genuine **0 findings**
across all 10 homepage files (verified with a falsifier file, so the zero is
real, not a no-op). Every file styles through Tailwind utilities and semantic
tokens, so the source rules — which match inline style strings — have no surface
to hit. **This is a detector blind spot, not a clean bill of health:** the design
review found 5 real radius violations expressed as `rounded-md` / `rounded-lg` /
`rounded-full` classes that source scanning cannot see.

The in-page scan found 87 items. Adjudicated against DESIGN.md:
- `undersized-ui-text` (71) — **mostly false positive.** The 10px label tier is a
  sanctioned typography role. **One true positive:** an 8px `⌘K` hint sits below
  the documented 10px floor.
- `nested-cards` (10) and `cream-palette` (1) — **false positives.** Flat nested
  surfaces and the warm-paper ground are the system's explicit intent.
- `all-caps-body` (2) — **true positive for a different reason:** the long
  uppercase string is a footer counts line that duplicates content already on the page.
- `heading-rhythm` (2) — **true positive, and the same root cause as P0 below**
  (0px above / 21px below).
- `text-overflow` (1) — **true positive**, a chart label overflowing by 17px.
- `layout-transition` (2) — animating `width`/`height` on the rail and body.

Where the two passes converged independently: zero region clearance, missing
headings (only 4 on a ~4,700px page), 9 `<button>`-in-`<a>` pairs, and label
truncation. Where measurement missed and judgment caught: donut slice labels at
roughly 1.2:1 contrast — the contrast sweep covered HTML text nodes, not SVG
fills, and reported 0 failures with a 4.78:1 worst case.

## Overall Impression

The parts are better than the whole. Individual cards show real discipline —
honest money provenance, server-side aggregates, drill-through counts that can't
drift from their destination. Then they are stacked flush against each other with
no clearance, in an order nobody argued for, under a permanent red alarm, and
topped off with a retired page's worth of charts.

The single biggest opportunity: **this page has no point of view about what the
household should do next.** It reports state. Every number that would change
behavior in the next ten minutes is small, low, or absent, while the largest
figures on the page are a net-worth total and a count of a third-party reference
database.

## What's Working

1. **`EntityCount` is the design system at full strength.** A bordered container
   with an internal `divide-x divide-y` hairline grid, negative margins killing
   the doubled edge where dividers meet the border, mono tabular numerals over
   eyebrow labels, zero per-entity color, whole cell as link target. It works
   because it *refuses* card chrome — the structure is the ruling.

2. **The money cards enforce product tenets visually, not just in the query.**
   `RecordedSpendCard` reads the server-side SQL aggregate and says so in its
   description ("actual expenses only"); `fillRecordedSpendMonths` materializes
   zero-months so the cadence can never lie by omission; negative net months
   render below the zero line rather than filtering refunds out. Honest-numbers
   discipline expressed as design.

3. **`HouseCard` stats are reachable, not decorative.** Each count links to the
   exact filtered Tasks view that produced it, reusing the same view mapping the
   Tasks page uses — so the number and its destination cannot drift apart.

## Priority Issues

### [P0] Zero clearance between all five top-level regions
- **Why it matters:** DESIGN.md reserves the 2–5rem steps for "page gutters,
  clearance, and major regions." With 0px everywhere, five separate arguments
  read as one run-on sentence and headings do all the grouping alone. This is the
  largest single reason the page feels like accumulation rather than a control
  sheet. The detector's `heading-rhythm` findings are this same defect measured
  mechanically.
- **Root cause:** `Page` applies `space-y-2` only on `variant="detail"`; the list
  variant gets `undefined`, so children stack flush. `Section` only spaces its own
  contents.
- **Fix:** Wrap list-variant children in `<Stack gap="lg">` inside `Page`, and
  give Insights an explicit major-region break so the operational and exploratory
  halves are visibly different regions.
- **Command:** `/impeccable layout`

### [P0] "Recent Activity" is the largest block on the page and carries no information
- **Why it matters:** It renders entity *type + shortcode* and nothing else, so
  six rows read as type-code-verb-timestamp with no name, no changed field, no
  location. It occupies the entire left column of the desktop middle grid — about
  twice the area of Quick Actions — and it is the page's only narrative element,
  so its emptiness is what the page's story amounts to. It also violates the
  repo's own rule that a rendered entity name is never plain truncated text; here
  the name is absent entirely.
- **Fix:** Render the entity **name** as primary text with the shortcode demoted
  to a mono suffix, and show the diff ("moved to <location>", "qty 3 → 1") instead
  of a bare verb stamp. If names can't be joined cheaply on this route, make the
  panel *smaller* than Quick Actions rather than double it.
- **Command:** `/impeccable clarify`

### [P1] "One Loud Thing" is violated in six places at once
- **Why it matters:** `--chart-1` is aliased directly to the brand ultramarine, so
  the interaction blue renders as every spend bar, the tallest pantry bar, the
  dominant donut slice, the entire sunburst ramp, all usage bars, and every
  activity link — plus the header badge and active nav. DESIGN.md reserves it for
  "an action, active state, focus, or **one** live value." When six unrelated
  regions are loud, none is. The actual live value renders in plain ink while a
  decorative sunburst is a solid field of the accent.
- **Fix:** Move chart series to the ink ladder on this surface; reserve
  ultramarine for exactly one value (current-month spend). Consider an ink alias
  so charts stop reaching for the brand token by default.
- **Command:** `/impeccable colorize`

### [P1] Insights is ~55% of the page, shifts layout ~1,800px, and three of four panels are illegible
- **Why it matters:** The least actionable content gets the most pixels, the most
  CPU, and all the cumulative layout shift — on an Operate surface whose premise
  is scanning while doing real work. `LazyMount` is called with no `minHeight`,
  defaulting to 200px against panels declared at 400/500/400px. Donut labels are
  hard-coded to paper fill regardless of slice color (~1.2:1 on pale slices);
  sunburst labels overlap on mobile; network labels truncate to four characters.
  The code comment itself says these are "the heaviest reads."
- **Fix:** Pass explicit `minHeight` at each call site; make the donut label pick
  ink-or-paper by slice luminance; and demote Insights to a link (restoring the
  route) or a `<details>` that defaults closed.
- **Command:** `/impeccable distill`

### [P1] Accessibility: nested interactives, hidden-but-focusable charts, and 8 cards with no heading
- **Why it matters:** 9 `<button>` inside `<a>` is invalid HTML producing doubled,
  ambiguously-announced tab stops. All three custom SVGs carry `aria-hidden="true"`
  while containing focusable `<Link>` elements — a direct WCAG 4.1.2 failure.
  `CardTitle` renders a `<div>` system-wide, so a ~4,700px page exposes exactly
  **four** headings, making heading navigation useless. Measured: 28 of ~61 tap
  targets under 44px, including the card-header drill links at **14px** and the
  problems banner — the page's most prominent CTA — at **26px**, against
  DESIGN.md's own 40–48px phone rule.
- **Fix:** `<Button asChild><Link/></Button>` for all nine; give each chart
  `role="img"` + a summarizing `aria-label` and drop `aria-hidden` from any SVG
  containing links; add an `as` prop to `CardTitle` so cards render `<h3>`; raise
  drill links and the banner to 40px+ on phone.
- **Command:** `/impeccable audit`

## Persona Red Flags

**Alex (power user).** 59 tab stops in `main`, some with ambiguous activation from
the nested `a > button` pairs. Quick Actions is 8 *creation* forms on a mature
database — the daily verbs here are recount, search, reconcile; only two of eight
tiles survive that test. Nothing is configurable: he cannot collapse Insights,
reorder the grid, or pin the counts he watches, so he pays four heavy queries on
every landing forever. The `⌘K` hint is disclosed only in the footer, thousands of
pixels down, at 8px.

**Sam (accessibility-dependent).** Four headings for a ~4,700px page; eight card
titles are `<div>`s and unreachable by heading navigation. Three whole panels are
hidden from assistive tech while containing focusable links. Donut labels at
~1.2:1. No `aria-live` anywhere — the problems banner appears seconds after paint
via `useIdle` with no announcement, and four panels mount silently on scroll. The
encouraging note: measured HTML text contrast bottoms out at 4.78:1, so static
prose is not the problem — structure and non-text content are.

**Jordan (household owner, iOS PWA, standing in the pantry).** The first 812px
contains a greeting, a red alarm, a heading, and the top edge of a net-worth
figure — nothing about what is on hand. The per-card drill links are **14px tall**
on a 375px phone, against DESIGN.md's explicit "don't shrink phone controls to
desktop density." ~3,700px of scroll, roughly half of it charts she cannot read
one-handed. "Current position" becomes a nine-row 2-column grid ending in an
orphan tile describing a third-party database, not her household. The saving grace
is entirely outside this page: the bottom tab bar puts Recount one tap away.

## Minor Observations

- **The count grid orphans a tile at every breakpoint.** The comment says "16
  cells → exact 8/4/2-column rows," but the array is 16 countable entities **plus**
  USDA foods = 17. The last cell sits alone at every tier.
- **The USDA reference count doesn't belong in "Current position"** — it measures
  a third-party table, not the household, and is by far the largest number shown.
- **The spend headline is invisible in its own chart** — one outlier month sets the
  y-axis, so the current-month bar is a sliver. Annotate the current bar or
  compress the scale.
- **Pantry bars floor at 8% height**, so the two smallest locations are visually
  indistinguishable and their relative sizes are a lie.
- **`UNKNOWN` ships as a location name.** Should read "Unassigned" or be excluded.
- **The middle region is anonymous** — a bare `<Grid>` between two titled
  `<Section>`s, which is exactly where the reading order stumbles.
- **The header date is `hidden sm:block`** — suppressed on the device where a
  working-record date stamp is most in character.
- **Card title casing is inconsistent** — "Recent Activity" and "Quick Actions" are
  Title Case; "Pantry value", "Recorded spend", "House", "Meals" are sentence case,
  all through the same component.
- **`rounded-full` legend swatches and dots** against the reserved-for-circular rule.
- **Quick Actions uses a raw `grid grid-cols-2`** instead of the `Grid` primitive.
- **The Meals empty state has no action** — "Nothing planned this week." with no
  "Plan a meal →"; both links below it assume a plan already exists.
- **The footer restates four counts** that appear verbatim in "Current position".
- **Two unresolved console errors on load** plus one aborted batched dashboard
  request; the message text is redacted by the browser tool, so this needs a
  separate look. Each of the three font files is requested 3× per load.
- **Good news:** no horizontal overflow at 375px, and exactly one `h1`.

## Questions to Consider

1. PRODUCT.md's first north star is "What can I cook tonight, and what would it
   cost?" Why is that a 14px mono link at the bottom of the fifth card, while a
   net-worth figure gets the top of the page?
2. Which number here changes what you do in the next ten minutes? Pantry value
   doesn't. USDA foods doesn't. Recipe count doesn't. "Overdue" might — and it's
   18px, fourth card down, in the unnamed region. What if you deleted every number
   that fails this test?
3. A problems counter that has never been zero is not an alert, it's wallpaper.
   What would it take to reach zero — and if the honest answer is "nothing will,"
   should it be a permanent red bar or a quiet mono figure with a breakdown?
4. If a section's queries are heavy enough to justify `LazyMount` on the
   most-visited route, why is it on that route at all? That's an argument for a
   link, not an IntersectionObserver.
5. DESIGN.md promises a record "carried between pantry, workshop, and desk."
   Which of the three is this page for? It's the desk one — and the desk is where
   the full list pages already work better. What would the *pantry* version
   contain, and why shouldn't that be what ships at 375px?
