# Cubby Field Guide on Apple platforms

The native app follows Apple navigation, controls, typography scaling, and system light/dark appearance. The shared brand roles come from `packages/design-tokens/tokens.json`; `pnpm generate` writes the adaptive color assets and Swift geometry. Keep the existing system AppKit and SwiftUI behavior when applying those roles.

## Appearance

Warm canvas and surface colors make records readable in light mode; their generated dark variants preserve contrast in dark mode. Ink is the interaction color, and citron is a sparse focus or attention mark. Cook, Pantry, Plan, House, and Finance are separate wayfinding colors. Positive, warning, and destructive tones remain condition colors paired with a word or symbol.

Use the system serif design for a record's human title or a major dashboard heading. Use standard SwiftUI text styles for body, controls, lists, forms, and settings so Dynamic Type works. Identifiers use mono; measurements and money use monospaced digits. Real entity images may lead a detail view. If an entity has no image, title and declared data lead it without an empty media box.

Use native `List`, `Form`, `Section`, `LabeledContent`, toolbars, sheets, menus, and split views. The warm canvas belongs to content, not a recreation of system bars or Liquid Glass. Resting panels use tonal separation and a hairline; overlays may use native elevation. Controls keep native hit behavior, and phone targets stay at least 44 points.

## Navigation and generic records

Mac has one main window and separate Settings. Catalog and Search use a grouped sidebar, selectable record list, adjacent complete detail, and an optional inspector. The inspector summarizes the already loaded row; the complete record and its actions remain in detail. Other workspaces use the main column. Keep menus, keyboard access, window restoration, selection, and related-record history.

iPhone keeps the Work, Capture, Library, and Find tabs with independent navigation stacks; iPad adapts to a sidebar. A pushed detail remains a complete route. Settings uses grouped native form sections. Preserve current search, filter, deep-link, and scroll behavior when switching presentation.

`EntityCatalog` and the entity manifest own names, icons, domain, image, fields, sections, relationships, list views, and available actions. A generic renderer uses those declarations for every entity. Specialist import, photo, fieldwork, and editor screens remain in declared slots or their owned flows. `NativePresentationCoverage` prevents unsupported renderers and actions from appearing operational; their existing web disclosure remains visible where needed.

Cached Mac lists and freshly opened lists select their initial layout from the same native coverage filter. If no declared layout can render natively, use the generic table; retain the cached model when switching sidebar sections.

## Density and feedback

Mac list rows prioritize comparison and native selection; iPhone rows use a readable primary line and concise supporting facts. A photo, summary, or inspector never pushes the next action off the useful first screen without purpose. At accessibility text sizes, columns and metrics wrap or stack. Preserve keyboard and VoiceOver labels, Reduce Motion, and Reduce Transparency.

Today uses its real task, meal, activity, problem, and nutrition sources. Attention is identified by the data and a readable label; the citron mark is supporting emphasis. Loading is labelled (`LoadingIndicator`), and same-context refresh retains loaded data. A failed load offers Retry through one of two shared views: `LoadFailureView` when a screen or sheet body never loaded, `InlineLoadFailure` (warning symbol and tone) when a section or slot fails beside loaded content. A refused write (an editor save, an accepted suggestion) is not a failed load: `ActionFailureNotice` shows "Couldn't save" and the raw server message above the preserved input, with Retry only while that same mutation can still be resent; where the failed action's own control remains, it omits Retry. Determinate progress (photo preparation) and named write or check progress ("Checking booking…") keep their own `ProgressView`. In-flight writes keep their existing dismissal rules.

## Acceptance

Review iPhone and Mac, narrow Mac windows, iPad resizing, light/dark, accessibility text, VoiceOver, keyboard-only operation, Reduce Motion, and the actual photo and workbench journeys. Use synthetic fixtures and screenshots.
