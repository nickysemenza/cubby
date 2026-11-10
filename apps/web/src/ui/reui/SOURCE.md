# ReUI source provenance

The copied components in this directory use the public ReUI Base UI / Mira
variant from:

- Repository: https://github.com/keenthemes/reui
- Source commit: `39c1f6849ab9a377896a9bcfc034a42546c017c5`
- License: MIT

Copied registry items:

- `event-calendar` → `event-calendar/` (also carries its own license notice)
- `badge` → `badge.tsx` and `alert` → `alert.tsx`, from the `@reui` base-mira
  registry as of 2026-11-05; refresh with `shadcn add @reui/badge @reui/alert --overwrite`
  and re-apply Cubby's tones and `pillVariants` composition

ReUI Number Field and Autocomplete were references for Cubby-owned NumberInput and Picker suggest mode.

Other evaluated items remain Cubby-owned:

- Cascader: about 9k lines and column navigation conflicts with grouped-list trees.
- Sortable: Cubby needs multi-container lists and custom sensors.
- Date Selector: stores Date objects and fires onChange on mount, breaking the plain-date contract.
- Time Picker: no consumer.
- Tree: adds an any-typed dependency; TreeOutline implements the WAI tree pattern.
- Stepper: linear, while Cubby steps have independent statuses.
- Timeline, Frame and Icon Tile: covered by RecordList, Panel and SidePanelIconTile.
- Scrollspy: writes location.hash outside the router.

Cubby-specific adaptations add strict TypeScript compatibility, event-class
hooks, and first-party adapters for Cubby entities. Filters and the file upload
hook are Cubby-owned modules outside this provenance notice.

Copyright (c) 2026 KeenThemes

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
