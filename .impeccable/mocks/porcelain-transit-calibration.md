# Porcelain Transit Products Calibration

The two approved desktop mocks are complementary, not alternatives:

- `porcelain-transit-route-led.png` owns expanded domain navigation, page
  wayfinding, and the horizontal relationship preview.
- `porcelain-transit-table-first.png` owns 28px grid rhythm, collapsed rail,
  selection behavior, and the vertical inspector journey.

Placeholder data and CRM labels in the images are non-authoritative.

## Desktop workbench

1. **Shell:** 224px expanded domain rail or 52–56px collapsed rail, 48px quiet
   command header, no content gutter around the workbench.
2. **Query band:** compact search, filter, view, density, and saved-layout
   controls. Selection actions replace or join this band without shifting the
   grid vertically.
3. **Grid:** 32px header and 28px read-heavy rows. Column rules stay quiet;
   selected context uses cobalt tint plus a 1px domain mark. Inline editors may
   rise to 32px but must not perturb the virtualizer's measured row height.
4. **Inspector:** modeless 400px dock at 1280px and wider. The grid keeps its
   scroll, filters, cell selection, and keyboard context when it opens.
5. **Route preview:** Product is the selected station. Stock, acquisition, and
   work-history branches appear only when supported by the truth matrix.
6. **Inspector journey:** identity, primary actions, `Overview`, `Relations`,
   and `Activity`; the chosen branch continues vertically through real linked
   records. Complex operations still open their dedicated route or dialog.

### Required desktop variants

- Inspector closed: grid consumes the available workbench width.
- Inspector open: 400px dock, selected row visibly remains selected.
- Inline edit: focused cell, validation error, saving, and committed states.
- Bulk selection: count and honest available/unavailable actions.
- Loading: geometry-matched rows and inspector skeleton.
- Empty: first-use and filtered-zero states remain distinguishable.
- Error/offline: recovery stays in the affected region without destroying the
  query/view context.

## Mobile calibration

1. Preserve the five-tab Cubby navigation, contextual masthead, semantic Back,
   safe-area insets, and virtual-keyboard handling.
2. `/products` uses the existing semantic list projection, not a squeezed grid.
   Rows remain compact but each interactive target is at least 44px.
3. Selecting a row opens the canonical Product detail route. Near its header, a
   horizontally scrollable route strip shows truthful direct branches.
4. `Relations` renders the same information as a stacked journey with counts,
   provenance labels, empty explanations, and canonical links.
5. Editing uses full-width fields, dialogs, or bottom sheets. There is no docked
   inspector on phone.
6. At 320×568 and 430×932, ordinary pages do not overflow horizontally; wide
   data appears through intentional projections or internal scrollers only.

### Required mobile variants

- Typical Product with stock, purchase, expense, project, and task branches.
- Sparse Product with no image, stock, or related work.
- Long name and large numeric values.
- Loading, filtered-empty, error, offline, and permission-limited states.
- Virtual keyboard open during search/edit.
- Landscape 844×390 with immersive and ordinary-route chrome verified.
