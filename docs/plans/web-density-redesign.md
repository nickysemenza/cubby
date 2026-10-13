# Web density redesign

Status: A+B implemented, retaining the ToC sidebar. Astra finish verdict: ship; the sole table-readability finding is resolved. DESIGN.md and the web component reference describe the built result.

## Confirmed scope and decisions

- Redesign the shared web shell and carry its density, spacing, surface geometry, and component conventions across detail pages, lists, forms, and work areas. Breaking visual and interaction changes are allowed; preserve product behavior and household data.
- Desktop prioritizes very dense, visible information. Save space through layout and hierarchy while retaining readable text, usable controls, and visible focus.
- Replace the global top bar with a compact contextual page header. Put global search and create utilities in the sidebar.
- Record details remain one scrolling page with one content column on desktop. Do not introduce tabs or split sections into desktop columns.
- Web remains light-only.
- Desktop is the primary design and verification target. Native Swift apps own mobile workflows; mobile web must still reflow, navigate, and expose its controls reliably.
- Consolidate repeated component geometry and remove redundant variants where their behavior is equivalent. Keep distinct control contracts and specialized workflow behavior.
- Record identity includes a small photo thumbnail beside the title when media exists. The full gallery stays in the Images section further down the page.
- Keep every empty field and section visible. Do not consolidate missing information into disclosures or omit empty sections to improve density.
- Keep Edit and the main workflow action visible. Put remaining actions, including review utilities and destructive actions, in an accessible overflow menu; retain their behavior and clear labels.

## Confirmed composition

- A compact, collapsible sidebar carries navigation, search, and create. Preserve the user's sidebar expansion preference.
- One contextual page header contains compact wayfinding, thumbnail and readable title, visible actions, and quiet metadata. Use a structural divider rather than a rounded title card. Action width must never collapse the title; wrap the header at constrained widths.
- Retain the ToC sidebar beside the single content column on wide work surfaces. A compact Jump to control supplies the same navigation below the existing available-width threshold. Preserve section targets, URL fragments, browser history, keyboard access, and mounted edit drafts.
- Sections span one content column. Use compact headings, aligned label/value rows, and horizontal rules; remove redundant enclosing cards. Empty values and sections stay legible with their actions available.
- Favor the references' neutral light surfaces, restrained color, compact type hierarchy, and small consistent control corners. Reserve rounded floating surfaces and elevation for overlays. Do not add decorative page-load motion.
- Apply the same header, spacing responsibilities, action hierarchy, and surface geometry across lists, editors, and work areas. Preserve workflow-specific tables, controls, and visualizations.

## Evidence and problems to address

- The shared detail header lets the action column consume the title's available width. Long titles and numerous actions must remain readable without overlap.
- App chrome, page identity, metadata, and actions form multiple stacked bands. Consolidate their responsibilities.
- Bounded record media precedes full-width facts, leaving unused horizontal space and delaying facts below the first viewport. Resolve the media treatment without introducing a second content column.
- Nested containers and multiple spacing owners produce inconsistent section rhythm. Give shared page and section primitives explicit spacing responsibilities.

## Open decisions

- No remaining product decisions. The user selected A+B and explicitly retained the ToC sidebar. Implementation combines open white sections with subtle inset heading bands, compact record identity, and the existing continuous-page navigation.

## Visual exploration

The agreed brief and supplied interface references pin a neutral, dense, light utility direction. The direction seed was run from `apps/web` (key `a9ed9de0`); its exploratory challengers do not override those explicit constraints. Three composition probes retain the agreed palette and single-column detail topology:

- Compact ledger: open white sections, quiet separators, a two-line contextual header.
- Section bands: compact gray heading strips strengthen grouping without enclosing cards.
- Inline index: a small section-anchor strip below record identity; the anchors scroll the same mounted document.

Each probe includes a detail page, dense list, and editor with synthetic content. These are concept previews, not evidence of shipped behavior or accessibility.

Local previews are saved under `apps/web/.impeccable/mocks/`: `a.png`, `b.png`, `c.png`, and `compare.html`. Each PNG carries its generation prompt; the A and B JSON sidecars record the approved combination and retained ToC. The comparison page was rendered at 900px and 360px; images loaded without page overflow, and option selection, enlargement, and fit controls passed preview checks. These concept-preview checks are separate from the implementation checks below.

Do not copy generated labels or control omissions into implementation. Use the real entity declarations and navigation roster; keep Edit and the main workflow action visible. The generated sidebar and form option labels are illustrative. Only list sections have counts under the actual detail contract. Density does not permit illegible text, invisible focus, or missing empty fields and sections.

## Failure modes and retained checks

- Long titles and action labels overlap or collapse identity: the new continuous-detail browser journey measures their rectangles at wide desktop, constrained desktop, and phone widths.
- Moving actions loses lazy review links, registered verbs, or editor dialogs: the same journey opens overflow, checks workflow controls, and opens and cancels Edit.
- Removing the global band makes search or create unreachable: the sidebar journey exercises both utilities and collapse behavior.
- Density or section framing hides empty sections or changes fragment navigation: retain the continuous contents journey for empty fields, section counts, focus, active navigation, and browser history.
- Moving record media mixes primary photos with evidence labels: retain the wardrobe image-purpose journey and target the header thumbnail instead of the removed Overview media block.

## Implementation and verification

The shared shell, record and list headers, section headings, forms, dashboard frames, ownership evidence rows, and control geometry now follow the approved direction. Removed the desktop global command bar, duplicate Overview media component, nested detail section frames, and obsolete responsive action branch. Full photo galleries, all declared empty sections, and continuous navigation remain.

Synthetic browser proofs cover long identity and actions at 1440px, 1024px, and 390px; a 19-record list; desktop and phone editors; sidebar utilities; and item-photo selection. Shared detail and action unit checks passed (47 tests). Generation and Worker builds passed. The focused five-scenario browser run passed four scenarios; a desktop empty-list count remained in Loading and passed its isolated replay. Final typecheck passed. Astra finish review requested readable spacing for two-line table values; table rows retain the existing 32px height while other ledgers and section chrome remain compact. The post-fix header/list/editor browser replay passed; Astra scored the readability fix resolved, with no remaining material findings. Outside-web workspace suites passed except one schema test timed out under contention; its isolated replay passed. These results do not claim full-suite or CI success.

## Delivery limits

The branch was rebased onto main without conflicts before PR creation. Local checks do not claim deployment or live CI success. Not run locally: full web/PostgreSQL/E2E suites, full lint/knip gates, Tester Army, Apple host/simulator/TestFlight/version-gate checks, physical devices, and motion-speed testing. No native or wire contract changed. Staged lint and formatting passed; final post-rebase typecheck is recorded in the PR evidence. The first independent finish run was interrupted; a restarted review was cancelled to honor the user's Sol/Luna/Astra-only fast-mode request. Completed review and verdict were both Astra in priority mode, with Sol in priority mode owning documentation.
