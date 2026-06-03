# Mobile Web — Implementation Plan

**Status:** Proposed · **Supersedes the mobile parts of:** [2026-01-05-mobile-first-experience-design.md](2026-01-05-mobile-first-experience-design.md)

The Jan design doc predates a lot of work. Verified against the code on 2026-06-02, most of its checklist already shipped. This plan targets only what's actually missing, scoped to three workstreams: **app-shell offline (PWA), scanner UX, and perf/skeleton polish.**

---

## What already shipped since the Jan design doc

| Jan doc item | Reality | Consequence |
|---|---|---|
| Pull-to-refresh (gesture + rubber-band + spinner) | **Done** — [`pull-to-refresh.tsx`](../../apps/web/src/components/ui/pull-to-refresh.tsx), wired through [`MobileListScreen.tsx`](../../apps/web/src/app/_components/data-table/MobileListScreen.tsx) via `useEntityList`'s `refreshControls`. | Drop from scope. |
| Batch location queries ("6 → 1") | **Done** — `inventory.getByLocationIds` / `getCountsByLocations` ([inventory.ts:240](../../apps/web/src/server/api/routers/inventory.ts)), consumed by [`location-card-grid.tsx:43`](../../apps/web/src/app/_components/locations/location-card-grid.tsx). | The headline N+1 is already fixed; perf work is now a *targeted audit*, not this one fix. |
| Skeleton placeholders | **Partial** — `MobileCardSkeletonList` renders during fetch ([MobileListScreen.tsx:91](../../apps/web/src/app/_components/data-table/MobileListScreen.tsx)), but there are **no `useTransition` skeletons on route navigation** and **no route-level code-splitting**. | Keep the navigation/transition half. |
| Mobile card layouts, virtualization | **Done** — [`mobile-card.tsx`](../../apps/web/src/components/entity/mobile-card.tsx) + `useWindowVirtualizer` in [`MobileCardView.tsx`](../../apps/web/src/app/_components/data-table/MobileCardView.tsx). | — |
| Service worker / offline | **Not done** — manifest + Apple splash exist ([manifest.json](../../apps/web/public/manifest.json), [__root.tsx:35](../../apps/web/src/routes/__root.tsx)) but there is **no service worker at all**. | The real offline gap. Workstream A. |

**Explicitly out of scope this round** (per scoping decision): swipe-to-delete, an install/A2HS prompt, full read-offline or offline-first data sync. **Haptics stays out** — `navigator.vibrate` is unavailable on iOS Safari (the only target), so there's no web API to drive it.

---

## Workstream A — App-shell PWA (service worker) 🎯 highest value

**Goal:** instant warm loads, app keeps its shell on flaky/no network, and a graceful offline page instead of the Safari dinosaur. **No data offline** — every route still fetches from the network when online.

### The SSR nuance that shapes the whole design

This is a **TanStack Start SSR app on Cloudflare Workers**. Two facts drive the approach:

1. **The service worker is a *client* artifact.** It runs in the browser and is served as a static asset — it does **not** execute inside the CF Worker. The CF Worker keeps doing SSR untouched.
2. **There is no single static "app shell" HTML.** Each route is server-rendered per request. So the classic "precache one index.html" trick doesn't apply. The app shell here is really: *precached static assets (JS/CSS/fonts/icons/WASM) + a runtime navigation strategy + one dedicated offline fallback page.*

### Approach: a post-build esbuild step (NOT vite-plugin-pwa) — ✅ BUILT

> **Spike finding (2026-06-02):** `vite-plugin-pwa` (`injectManifest`) **silently emits nothing** under TanStack Start's multi-environment (Vite Environments API) build + `@cloudflare/vite-plugin` — it never hooks the client build, no error, no `sw.js`. Rather than fight fragile plugin ordering, we do what this codebase already does for CF build quirks ([cfWasmPlugin etc.](../../apps/web/vite.config.ts)): a deterministic post-build script. Net implementation:
>
> - **[`scripts/build-sw.mjs`](../../apps/web/scripts/build-sw.mjs)** — globs the finished `dist/client`, computes a content-hash precache manifest (JS/CSS/woff2/wasm/svg + `icon-*`/`favicon`/`offline.html`, excludes the megabyte iOS `splash/**`), and bundles [`src/sw.ts`](../../apps/web/src/sw.ts) with esbuild, injecting the manifest via `define: { "self.__WB_MANIFEST": ... }`. Chained onto `build:cf`. Verified: emits `dist/client/sw.js` precaching **201 assets** incl. the recipebridge WASM.
> - **[`src/sw.ts`](../../apps/web/src/sw.ts)** — hand-rolled, zero runtime deps. Precache + cache-first assets + NetworkFirst navigations → `/offline.html`; bypasses `/api`+`/trpc`; commit-hash cache name with old-cache cleanup on activate; `skipWaiting`/`clientsClaim`. Typechecked via a dedicated [`tsconfig.sw.json`](../../apps/web/tsconfig.sw.json) (WebWorker lib; excluded from the DOM-typed app config).
> - **[`public/offline.html`](../../apps/web/public/offline.html)** — standalone static page (no SPA boot → no hydration mismatch), on-brand warm palette + chunky button. Visually verified at mobile size.
> - **Registration** — prod-only, best-effort, in the client block of [`router.tsx`](../../apps/web/src/router.tsx).
> - **Known limit:** the barcode scanner's ZXing WASM loads from a jsDelivr CDN at runtime, so it is **not** precached → scanning still needs network. Self-hosting that blob is a Workstream B candidate (faster first scan + offline scan).
> - **Verified live (2026-06-02, `preview:cf` wrangler on :8788):** SW auto-registers, reaches `activated`, controls the page (root scope), and precaches **221 assets** incl. `offline.html` + recipebridge WASM. `/sw.js` + `/offline.html` served at root by the Worker's asset handler (200, `text/javascript`), confirming `assets.directory=../client` + no `run_worker_first` serves them ahead of SSR. A `web-cf` entry was added to `.claude/launch.json` (reads `DATABASE_URL` from `apps/web/.env` for the Hyperdrive local override — no creds committed).
> - **Two bugs this caught (would have shipped silently):**
>   1. **Registration gated on `import.meta.env.PROD`, which is `false` in this CF build** (it also zeroes the Sentry replay sample rates — see [[cf-build-prod-flag-false]]). The whole `if (isProd && …)` block was dead-code-eliminated → SW never registered. Fixed: gate on the `__CF_WORKERS__` define instead.
>   2. **`window.addEventListener("load", …)` never fired** — this module runs during hydration, *after* `load`. Fixed: register immediately when `document.readyState === "complete"`, else wait for `load`. Both fixes in [`router.tsx`](../../apps/web/src/router.tsx).
> - **Not yet exercised:** the true offline-reload screenshot (the preview-managed server auto-restarts, so killing it to force a network failure fought the harness) and the `/api`+`/trpc` bypass under real load. The offline page itself is precached and render-verified; the fallback handler is a 6-line branch over it.

The notes below are the original design rationale (still accurate for *what* the SW does):

Use **`injectManifest` semantics** (we control caching precisely):

- **Precache** the build's static assets via the injected manifest: app JS/CSS chunks, fonts (`@fontsource-variable/*`), PWA icons, and the **WASM blobs** (`barcode-detector` ponyfill WASM + `@cubby/recipebridge`). Precaching WASM is what makes the scanner and cost math work on a warm/degraded connection.
- **Navigations** (`request.mode === "navigate"`): `NetworkFirst` with a short timeout, falling back to a static **`/offline`** route when the network fails. Never cache authenticated HTML responses.
- **Never touch** `/api/*`, tRPC, or auth endpoints — bypass the SW entirely for those so nothing stale or auth-sensitive is served.
- **Versioning:** cache name keyed to `__GIT_COMMIT__` (already defined in [vite.config.ts:109](../../apps/web/vite.config.ts)); `skipWaiting` + `clientsClaim`, and clean up old caches on `activate`.

### Steps

1. **Add the plugin** — `vite-plugin-pwa` in [vite.config.ts](../../apps/web/vite.config.ts), `strategies: "injectManifest"`, `srcDir: "src"`, `filename: "sw.ts"`. Order it so it composes with the existing `wasm()` and `cloudflare()` plugins; confirm the SW emits into the **client** build output, not the Worker bundle. Use `devOptions.enabled` cautiously (SW + Vite HMR is noisy in dev).
2. **Write `src/sw.ts`** — `precacheAndRoute(self.__WB_MANIFEST)` + the `NetworkFirst` navigation route + the bypass rules above. Keep it small and readable.
3. **Add an `/offline` route** — a static, dependency-free TanStack route under [`routes/`](../../apps/web/src/routes/) using the existing chunky/warm styling. Precache it so it's always available.
4. **Register the SW** — register in [`__root.tsx`](../../apps/web/src/routes/__root.tsx) (client-only guard: `if ("serviceWorker" in navigator && !import.meta.env.DEV)`). Optional, low-priority: a tiny "new version available — reload" toast on `waiting`.
5. **Move `manifest.json` into the plugin** (optional cleanup) so manifest + SW are configured in one place, or leave the static file and point the plugin at it.

### Verify

- `preview:cf` build: SW registers, `/offline` shows when offline (DevTools → Network → Offline, reload).
- Warm second load pulls JS/CSS/WASM from the SW cache (Network panel shows `(ServiceWorker)`).
- Auth still works: log out / protected redirects are **not** served from cache; `/api`/tRPC always hit network.
- WASM scanner + recipe costing work on a warm load.

**Exit criteria:** second visit is instant from cache; offline reload shows the branded `/offline` page; auth and data fetching are unaffected online.

---

## Workstream B — Scanner UX upgrades

The scanner works ([`useBarcodeScanner.ts`](../../apps/web/src/app/_components/inventory/useBarcodeScanner.ts), [`persistent-scanner.tsx`](../../apps/web/src/app/_components/inventory/persistent-scanner.tsx)) but has three concrete weaknesses. This is the one area where the web genuinely lags native, so it's worth the polish.

### B1 — Faster, steadier lock-on (perf)

Today the detection loop runs `detector.detect(video)` on the **full frame every `requestAnimationFrame`** ([useBarcodeScanner.ts:170-203](../../apps/web/src/app/_components/inventory/useBarcodeScanner.ts)) — on a 1920×1080 frame that's wasteful and can stutter the preview.

- **Throttle detection** to ~10–12 Hz (every ~90ms) instead of every frame — decouples decode cost from render smoothness.
- **Region-of-interest crop:** draw only the central scan-box region to a small offscreen canvas and detect on that. Less pixels → faster decode → quicker lock, and it naturally ignores barcodes outside the reticle.
- Pick the **most central** result when `results.length > 1` instead of `results[0]`, so the box reticle means something.

### B2 — Honest permission recovery on iOS

`retry()` ([useBarcodeScanner.ts:110](../../apps/web/src/app/_components/inventory/useBarcodeScanner.ts)) re-calls `getUserMedia`, but **iOS Safari won't re-prompt once denied** — the retry silently fails and the user is stuck. Detect the `permission_denied` state on iOS and show the real fix: *"Camera is blocked. Open Settings → Safari → Camera (or the AA menu → Website Settings) to allow it."* Keep `retry()` for the genuinely-recoverable cases (transient `NotReadableError`, camera busy).

### B3 — Continuous multi-add feedback

The hook already supports continuous scanning (2s same-code debounce). The gap is **feedback during a run**: make the multi-add loop legible — a visible running tally / recently-scanned chip list and a clear success pulse per add — so you can rip through a grocery haul without looking at the form. (Confirm exact wiring against [`quick-capture-form.tsx`](../../apps/web/src/app/inventory/quick-capture/quick-capture-form.tsx) before building; the green-flash primitive already exists in `persistent-scanner.tsx`.)

### Verify

Manual on a real iPhone (scanning is hard to e2e): lock-on feels faster, denied-permission shows correct iOS instructions, a multi-item run shows live feedback. Add/adjust a unit test for the ROI/throttle helper if it's extracted as a pure function.

**Exit criteria:** noticeably faster lock-on, no dead-end on iOS permission denial, legible multi-add.

---

## Workstream C — Perf + skeleton polish

The big N+1 is already fixed, so this is targeted.

### C1 — Critical-bundle trimming — ✅ DONE (premise corrected)

> **Finding (2026-06-02):** the explorer's "no route code-splitting" was **wrong**. TanStack Start's `autoCodeSplitting` is **already the default** (`true`) in 1.168 — routes are split, heavy charts/Graphviz are already their own lazy chunks. Setting the flag explicitly was byte-for-byte a no-op (reverted). So the lever wasn't "enable splitting" — it was trimming what's eagerly in the **critical entry**.
>
> **What shipped:** the `GlobalCommandMenu` was statically imported and always mounted in [`__root.tsx`](../../apps/web/src/routes/__root.tsx), dragging **cmdk + react-markdown + remark-gfm + the agent stream** into first paint despite only being used on ⌘K. Now `React.lazy` + mount-on-first-open; the ⌘K hotkey moved into the shell (lightweight `keydown`) so the shortcut still works before the menu loads, and the menu's own duplicate listener was removed ([command-menu.tsx](../../apps/web/src/app/_components/command-menu.tsx)).
>
> **Measured:** client entry **1,604,241 → 1,301,272 bytes (−303 KB, ~19%)**; `react-markdown` now a lazy 187 KB chunk. Verified in-browser: ⌘K opens/toggles, search button opens, no errors.
>
> **Remaining candidates (not yet done):** Sentry SDK is eagerly initialized in [`router.tsx`](../../apps/web/src/router.tsx) (replay integration is the heavy part — already prod-only-sampled). A proper treemap (`rollup-plugin-visualizer`, temporary) would confirm the next-biggest critical-path items before cutting further.

### C2 — `useTransition` navigation skeletons

List fetch already shows skeletons, but **route transitions** don't. Wrap navigation in `useTransition` and surface the existing skeleton primitives ([loading-skeletons.tsx](../../apps/web/src/components/feedback/loading-skeletons.tsx)) during the pending state so tapping into a detail page doesn't flash blank. Hook into TanStack Router's pending/`defaultPendingComponent` rather than hand-rolling.

### C3 — Residual N+1 audit

Sweep for remaining per-card/per-row query patterns beyond locations (products, recipes, inventory detail). Where a list issues one query per row, batch it the way `getByLocationIds` did. Likely small or empty — timeboxed.

### Verify

Lighthouse/coverage before-after for C1; visually confirm no blank-flash on navigation for C2; for C3, the network panel shows constant query count regardless of row count.

**Exit criteria:** smaller initial bundle, no blank flashes between routes, no remaining per-row query fans.

---

## Suggested sequence

1. **A (service worker)** — highest value, self-contained, de-risks the PWA story.
2. **C1 (code-splitting)** — quick, compounds with A for fast mobile loads.
3. **B1/B2 (scanner perf + iOS perms)** — the daily-driver flow.
4. **C2, B3, C3** — polish.

## Risks / watch-items

- **`vite-plugin-pwa` × TanStack Start × `@cloudflare/vite-plugin`** is the main integration risk — three plugins touching the build graph. The SW must emit into the **client** bundle and must not be pulled into the Worker bundle. Spike step 1 of Workstream A in isolation before building the rest. (Same WASM-on-CF caveat already documented for the availability engine applies to precaching the WASM blobs.)
- **Don't cache auth/SSR HTML.** A precached or NetworkFirst-cached authenticated page that outlives the session is a correctness/security bug. Bypass `/api`, tRPC, and auth routes explicitly; only ever fall back to the static `/offline` page.
- **iOS PWA SW quirks** — installed-PWA service workers on iOS have had update/eviction oddities historically. Keep `skipWaiting`/`clientsClaim` and commit-keyed cache names so a deploy can't strand a client on stale chunks.
- **Scanner ROI crop** must track the *displayed* reticle box, accounting for `object-fit` on the `<video>`, or it'll decode the wrong region.

## Out of scope (this round)

Swipe-to-delete, install/A2HS prompt, haptics (no iOS web API), read-offline data caching, offline-first mutation queue/sync. Each is its own future item; read-offline is the natural next step if app-shell offline proves useful.
