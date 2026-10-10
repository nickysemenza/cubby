# Cubby Field Guide on Apple platforms

The native app follows Apple navigation, controls, typography scaling, and system light/dark appearance. The shared brand roles come from `packages/design-tokens/tokens.json`; `pnpm generate` writes the adaptive color assets and Swift geometry. Keep the existing system AppKit and SwiftUI behavior when applying those roles.

## Appearance

Warm canvas and surface colors make records readable in light mode; their generated dark variants preserve contrast in dark mode. Ink is the interaction color, and citron is a sparse focus or attention mark. Cook, Pantry, Plan, House, and Finance are separate wayfinding colors. Positive, warning, and destructive tones remain condition colors paired with a word or symbol.

Use the system serif design for a record's human title or a major dashboard heading. Use standard SwiftUI text styles for body, controls, lists, forms, and settings so Dynamic Type works. Identifiers use mono; measurements and money use monospaced digits. Real entity images may lead a detail view. If an entity has no image, title and declared data lead it without an empty media box.

Use native `List`, `Form`, `Section`, `LabeledContent`, toolbars, sheets, menus, and split views. The warm canvas belongs to content, not a recreation of system bars or Liquid Glass. Resting panels use tonal separation and a hairline; overlays may use native elevation. Controls keep native hit behavior, and phone targets stay at least 44 points.

## Navigation and generic records

Mac has one main window with Settings in its sidebar. The sidebar is a native `List(.sidebar)` at small sidebar row size in a narrow column (170–260 points, ideal 200). Each domain section is collapsible, and the collapsed set persists across launches and windows. Catalog and Search use a grouped sidebar, selectable record list, adjacent complete detail, and an optional inspector. The inspector summarizes the already loaded row; the complete record and its actions remain in detail. Other workspaces use the main column. Keep menus, keyboard access, window restoration, selection, and related-record history.

iPhone keeps the Work, Capture, Library, and Find tabs with independent navigation stacks; iPad adapts to a sidebar. A pushed detail remains a complete route. Settings is a selectable sidebar pane on Mac and iPad, using grouped native form sections. The iPhone keeps its existing Settings screen without adding a fifth primary tab. On Mac, the app menu and ⌘, open the main window’s Settings pane; server setup remains reachable before sign-in. Preserve current search, filter, deep-link, and scroll behavior when switching presentation.

`EntityCatalog` and the entity manifest own names, icons, domain, image, fields, sections, relationships, list views, and available actions. A generic renderer uses those declarations for every entity. Specialist import, photo, fieldwork, and editor screens remain in declared slots or their owned flows. `NativePresentationCoverage` prevents unsupported renderers and actions from appearing operational; their existing web disclosure remains visible where needed.

Cached Mac lists and freshly opened lists select their initial layout from the same native coverage filter. If no declared layout can render natively, use the generic List presentation; retain the cached model when switching sidebar sections.

Every entity offers List and Table alongside its declared shelf, timeline, or specialist views. Table uses the same manifest fields and display rules as web, with aligned column headers, column visibility controls, and server sorting only for declared sortable fields. Mac uses a native selectable table with resizable columns; iPhone keeps the columns in a horizontally scrolling table. Switching List and Table retains the loaded records, filters, search, and selection. A header sort restarts server pagination and replays an active search in the new order.

The Mac root browser owns split selection even while its detail pane has related-record history. Nested entity lists push a detail onto their current navigation path. Values and source attribution in phone table cells wrap at accessibility text sizes. Totals and paging controls stay within the viewport, outside the horizontally scrolling columns.

Native Mac table cells explicitly receive the owning AppModel so sorting and row reuse preserve field explanation dependencies. Reference cells in the root split browser open through its detail navigator; nested tables use their enclosing navigation stack. The browse screen contains its accessibility children, preserving the table, column control, and summary identifiers.

## Density and feedback

Mac list rows prioritize comparison and native selection; iPhone rows use a readable primary line and concise supporting facts. A photo, summary, or inspector never pushes the next action off the useful first screen without purpose. At accessibility text sizes, columns and metrics wrap or stack. Preserve keyboard and VoiceOver labels, Reduce Motion, and Reduce Transparency.

Spacing follows the compact 4/8/12/12/16/16 rhythm (`FieldGuideTokens.Space` xs…xxl, generated from the shared tokens): `lg` equals `md` and `xxl` equals `xl`. Screen and sheet content uses explicit token padding (`Space.md`/`Space.lg`, 12 points), never SwiftUI's default `.padding()`. Tab roots and pushed screens use inline navigation titles with no second in-content title. A record detail's title uses `fieldGuideRecordTitle`: the headline size on iPhone and the display size on Mac. Record counts beside a sidebar or catalog row are plain, muted, tabular digits at the trailing edge, with no badge box. Density never shrinks a phone target below 44 points.

Entity List rows keep one primary title line and a concise supporting band at standard text sizes, using smaller thumbnails and inline status and explanation controls. Accessibility text sizes allow those facts to wrap, and phone rows and controls retain 44-point touch targets. Data-quality explanations, source attribution, and deferred-detail loading or failure remain available in the compact presentation.

Today uses its real task, meal, activity, problem, and nutrition sources. Attention is identified by the data and a readable label; the citron mark is supporting emphasis. Loading is labelled (`LoadingIndicator`), and same-context refresh retains loaded data. A failed load offers Retry through one of two shared views: `LoadFailureView` when a screen or sheet body never loaded, `InlineLoadFailure` (warning symbol and tone) when a section or slot fails beside loaded content. A refused write (an editor save, an accepted suggestion) is not a failed load: `ActionFailureNotice` shows "Couldn't save" and the raw server message above the preserved input, with Retry only while that same mutation can still be resent; where the failed action's own control remains, it omits Retry. Determinate progress (photo preparation) and named write or check progress ("Checking booking…") keep their own `ProgressView`. In-flight writes keep their existing dismissal rules.

## Acceptance

Review iPhone and Mac, narrow Mac windows, iPad resizing, light/dark, accessibility text, VoiceOver, keyboard-only operation, Reduce Motion, and the actual photo and workbench journeys. Use synthetic fixtures and screenshots.
