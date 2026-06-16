# Mobile Web — Scanner & Perf (remaining)

**Status:** App-shell PWA (service worker), critical-bundle trimming, and
route-transition skeletons shipped. What remains is scanner UX and a residual N+1
audit — the parts where the mobile web genuinely lags native. Backlog summary in
[docs/todos.md](../todos.md#mobile--pwa); this is the implementation depth.

---

## Scanner UX upgrades

The scanner works ([`useBarcodeScanner.ts`](../../apps/web/src/app/_components/inventory/useBarcodeScanner.ts),
[`persistent-scanner.tsx`](../../apps/web/src/app/_components/inventory/persistent-scanner.tsx))
but has three concrete weaknesses.

### B1 — Faster, steadier lock-on (perf)
Detection runs `detector.detect(video)` on the **full frame every `requestAnimationFrame`**
([useBarcodeScanner.ts:170-203](../../apps/web/src/app/_components/inventory/useBarcodeScanner.ts))
— wasteful on a 1920×1080 frame and can stutter the preview.
- **Throttle** detection to ~10–12 Hz (~90ms) instead of every frame — decouples decode
  cost from render smoothness.
- **Region-of-interest crop:** draw only the central scan-box region to a small offscreen
  canvas and detect on that. Fewer pixels → faster decode → quicker lock, and it naturally
  ignores barcodes outside the reticle. **Must track the *displayed* reticle box**,
  accounting for `object-fit` on the `<video>`, or it decodes the wrong region.
- Pick the **most central** result when `results.length > 1` instead of `results[0]`.

### B2 — Honest permission recovery on iOS
`retry()` ([useBarcodeScanner.ts:110](../../apps/web/src/app/_components/inventory/useBarcodeScanner.ts))
re-calls `getUserMedia`, but **iOS Safari won't re-prompt once denied** — the retry
silently fails and the user is stuck. Detect the `permission_denied` state on iOS and
show the real fix: *"Camera is blocked. Open Settings → Safari → Camera (or the AA menu →
Website Settings) to allow it."* Keep `retry()` for the genuinely-recoverable cases
(transient `NotReadableError`, camera busy).

### B3 — Continuous multi-add feedback
The hook already supports continuous scanning (2s same-code debounce). The gap is
**feedback during a run**: a visible running tally / recently-scanned chip list + a clear
success pulse per add, so a grocery haul can be ripped through without watching the form.
The green-flash primitive already exists in `persistent-scanner.tsx`; confirm wiring
against [`quick-capture-form.tsx`](../../apps/web/src/app/inventory/quick-capture/quick-capture-form.tsx).

**Verify:** manual on a real iPhone (scanning is hard to e2e) — lock-on feels faster,
denied-permission shows correct iOS instructions, a multi-item run shows live feedback.
Add a unit test for the ROI/throttle helper if it's extracted as a pure function.

### Related: self-host the ZXing WASM
The scanner's ZXing WASM loads from a jsDelivr CDN at runtime, so the service worker can't
precache it → scanning still needs network. Self-hosting the blob enables faster first scan
+ offline scan.

---

## Residual N+1 audit

The headline N+1 (location cards) is already fixed (`getByLocationIds` /
`getCountsByLocations`, consumed by `location-card-grid.tsx`). Sweep for remaining
per-card/per-row query patterns (products, recipes, inventory detail) and batch them the
same way. Likely small — timeboxed. Network panel should show a constant query count
regardless of row count.

---

## Lower-priority bundle candidate

Sentry SDK is eagerly initialized in [`router.tsx`](../../apps/web/src/router.tsx); the
replay integration is the heavy part (already prod-only-sampled). A temporary
`rollup-plugin-visualizer` treemap would confirm the next-biggest critical-path items
before cutting further.

---

## Out of scope (this round)

Swipe-to-delete, install/A2HS prompt, haptics (no iOS web API — `navigator.vibrate` is
unavailable on iOS Safari, the only target), read-offline data caching, offline-first
mutation queue/sync.
