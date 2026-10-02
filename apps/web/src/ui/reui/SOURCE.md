# ReUI source provenance

The copied components in this directory use the public ReUI Base UI / Mira
variant from:

- Repository: https://github.com/keenthemes/reui
- Source commit: `39c1f6849ab9a377896a9bcfc034a42546c017c5`
- License: MIT

Copied registry items:

- `event-calendar` → `components/reui/event-calendar/` (also carries its own license notice)
- `timeline` → `components/reui/timeline.tsx` (now specialized as the audit timeline)

Cubby-specific adaptations add strict TypeScript compatibility, event-class
hooks, and first-party adapters for Cubby entities. The former copied filters and file
upload hook were replaced with Cubby-owned modules and are no longer covered
by this provenance notice.

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
