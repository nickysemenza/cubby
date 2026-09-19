# Cubby native design

The Apple app follows platform conventions. This is the native design authority;
`apps/web/DESIGN.md` applies to the web application.

## Appearance

### App icon

`App/AppIcon.icon` is the shared iPhone, iPad, and Mac icon. It carries the web
favicon's six colors and two rows of objects into a softly sculpted porcelain
shelf. Keep the front-facing arrangement, generous spacing, and simple circles
and rounded rectangles; the mark must read at small Home Screen and Dock sizes.

The seven SVG layers use a 1024 × 1024 canvas: one shelf layer and six separate
objects. Keep their artwork flat and unmasked. Icon Composer owns the material,
highlights, shadows, and platform mask. Default uses porcelain `#f7f9fc`; dark
uses charcoal `#171a21` with gray `#9aa7b8` shelves. A shared 85% gray annotation
keeps objects legible in system clear and tinted appearances. Review both design
generations 26 and 27 when changing the composition.

Regenerate `App/Assets.xcassets/AppIcon.appiconset` fallbacks from the same Icon
Composer document. Export the iOS default at 1024 pixels and flatten transparency
over the porcelain background so iOS can apply its own mask. Export macOS at
512 and 1024 pixels with native padding and transparency preserved; do not reuse
the iOS bitmap for the Mac 2× slot. The web favicon and PWA assets are independent.

### Interface

Use system surfaces, primary/secondary text, standard text styles, and native
List, Form, Section, LabeledContent, toolbar, and sheet presentations. Respect
system light/dark appearance. Cubby's adaptive cobalt accent denotes interaction;
small domain marks denote wayfinding. Status always includes a word or symbol.
Do not recreate system bars or apply glass to content backgrounds.

Specialized workbenches can group content with GroupBox. Ordinary data rows use
native separators and selection. Phone targets are at least 44 points; Mac
controls use native density. Content wraps or stacks at accessibility text sizes.
Use monospaced digits for quantities and a monospaced face only for identifiers.

## Density

The app is high-density on every view — screen space goes to content, not chrome. This is a
standing rule, not a one-off for any single flow; other screens adopt it as they are touched.

- Inline navigation titles by default; reserve `.large` display mode for a screen with no other
  competing content.
- System spacing: omit `padding`/`spacing` lengths rather than hand-picking a number such as
  `.padding(16)` — the system value adapts across platform, size class, and Dynamic Type. See
  `axiom-design` (`skills/hig.md`, "What spacing, padding, or margin value should I use?").
- Default control sizes; `.controlSize(.large)` only for a lone primary action on an otherwise
  empty screen, never mixed into a list or a busy footer.
- Actions live in toolbar placements (`.bottomBar`, `.confirmationAction`, `.cancellationAction`,
  `.secondaryAction`, a toolbar `Menu`, …), never a hand-built `HStack + .background(.bar)` footer
  or pill — the system toolbar is already Liquid Glass.
- Hero media (a focused photo, a large preview) is at most ~22% of the container height on
  phones, e.g. `containerRelativeFrame(.vertical) { min(220, $0 * 0.22) }`, so the rest of the
  screen stays usable.
- List rows keep default insets; do not add a per-row `.padding(16)` or similar "to give it room."
- Check every new or touched view at iPhone width and compact height (landscape) — that is where
  a screen built at iPad proportions runs out of room first.

### Developer overlays

`@Environment(\.developerOverlays)`'s layers never shift layout — overlay/caption content only,
set with `Font.porcelainCode` and secondary color, added to an existing view rather than reserving
new space of its own.

## Navigation

On iPhone retain Today, Capture, Photos, Browse, and Search, each with an independent
navigation stack. Returning from details preserves the current session's query,
selection, and scroll position. No new persisted phone resume state.

Mac has one main Window and separate Settings. Catalog and Search browsing use a
sidebar, selectable record list, and adjacent detail. Other workflows use the
workspace directly. Navigator owns selections and related-record history, outside
adaptive layout branches. Controls remain keyboard accessible. Primary record
content belongs in detail, not an inspector. Media alone uses immersive transitions.

## Tasks and feedback

Form style does not determine sheet size: apply nativeSheet to the presented root.
Short adjustments offer medium/large on iPhone (large at accessibility text sizes);
searchable pickers and editors are large. Photo review/import is page-sized, and
photo viewing is full-screen on iPhone with an explicit Close. Native camera/library
presentation stays system-owned.

Changed drafts offer Discard from Cancel. Failed saves preserve input. In-flight
writes prevent dismissal, with explicit progress. Preserve every workflow's existing
immediate/staged-write contract. Recount quantities are finite positive numbers;
zero is the separate Remove action.

Initial loads expose labelled progress and retryable errors. Same-context refreshes
retain loaded content and show errors inline. New queries invalidate stale matches.
Do not render preview fixtures as loading data. Preserve existing scan feedback,
avoid duplicate haptics, and respect Reduce Motion.

## Acceptance

Validate iPhone and Mac workflows, iPad resizing, light/dark, accessibility text,
VoiceOver, keyboard-only navigation, Reduce Motion, and Reduce Transparency.
