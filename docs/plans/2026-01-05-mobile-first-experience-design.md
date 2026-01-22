# First-Class Mobile Experience

**Goal:** Transform the web app into an iOS-native-feeling experience with PWA, improved scanner, better performance, and touch-friendly UX.

**Target:** iOS only (no Android considerations)

---

## 1. PWA Foundation

### Files to create/modify:
- `apps/web/public/manifest.json` (new)
- `apps/web/public/sw.js` (new service worker)
- `apps/web/public/icons/` (new - app icons)
- `apps/web/src/routes/__root.tsx` (add manifest link, viewport meta)

### Changes:
1. **manifest.json**
   ```json
   {
     "name": "cubby",
     "short_name": "cubby",
     "start_url": "/inventory/scanner",
     "display": "standalone",
     "background_color": "#ffffff",
     "theme_color": "#your-brand-color",
     "icons": [...]
   }
   ```

2. **Viewport lock** (prevents Safari zoom)
   ```html
   <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
   ```

3. **Service worker** - cache app shell + static assets for instant loads

4. **App icons** - 180x180 (iOS), 192x192, 512x512

5. **iOS meta tags**
   ```html
   <meta name="apple-mobile-web-app-capable" content="yes">
   <meta name="apple-mobile-web-app-status-bar-style" content="default">
   <link rel="apple-touch-icon" href="/icons/icon-180.png">
   ```

---

## 2. Scanner Overhaul

### Files to modify:
- `apps/web/src/routes/inventory.scanner.tsx`
- `apps/web/src/app/_components/barcode/barcode-scanner.tsx`
- `apps/web/src/app/_components/barcode/scanner-form.tsx`

### Changes:
1. **Persistent scanner view** - remove modal, camera always live on `/inventory/scanner`
   - Location picker floats as overlay on camera
   - Full-width camera preview

2. **Torch button** - expose `html5-qrcode` flashlight toggle in UI

3. **Faster init** - request camera permission on page load, not button tap

4. **Recognition tuning**
   - Bump from 20fps to 30fps
   - Add visual scan frame overlay for alignment guidance
   - Consider adding CODE_128 format for non-UPC products

5. **Audio feedback** - play beep sound on successful scan (haptics limited on iOS web)

6. **Start URL** - PWA opens directly to scanner page

---

## 3. Performance Optimizations

### Files to modify:
- `apps/web/src/app/_components/data-table/Table.tsx`
- `apps/web/src/app/_components/data-table/MobileCardView.tsx`
- `apps/web/src/app/_components/locations/location-card-grid.tsx`
- `apps/web/src/lib/table-utils.ts`
- `apps/web/src/routes/__root.tsx` (prefetch logic)

### Changes:
1. **Mobile page size: 25**
   - Detect mobile via `window.innerWidth < 768`
   - Default to 25 items instead of 50

2. **Add virtualization**
   - Install `@tanstack/react-virtual`
   - Wrap table body / mobile card list in virtualizer
   - Only render visible rows

3. **Batch location queries**
   - Replace per-card inventory queries with single batch query
   - Current: 6 cards = 6 queries → Target: 1 query

4. **Skeleton placeholders**
   - Show pulsing skeletons during `useTransition` pending state
   - Smoother route transitions and filter changes

5. **Prefetch on touchstart**
   - Add `onTouchStart` prefetch to Link components
   - ~100-200ms head start before tap completes

6. **Lazy load images**
   - Add `loading="lazy"` to product/entity images in cards

---

## 4. Mobile UX

### Files to create/modify:
- `apps/web/src/app/_components/navigation/bottom-nav.tsx` (new)
- `apps/web/src/app/_components/MainNav.tsx` (hide hamburger on mobile)
- `apps/web/src/app/_components/entity/mobile-card.tsx` (add swipe)
- `apps/web/src/styles.css` (safe area, touch states)

### Changes:
1. **Bottom navigation bar**
   - Fixed footer with icons: Scanner, Inventory, Recipes, Products, More
   - Hide hamburger menu on mobile (show on desktop)
   - Account for iOS safe area:
     ```css
     padding-bottom: env(safe-area-inset-bottom);
     ```

2. **Swipe to delete**
   - On inventory/product mobile cards
   - Swipe left reveals delete action
   - Use `react-swipeable` or custom touch handlers

3. **Pull to refresh**
   - Add pull-down gesture on list pages
   - Rubber-band effect + spinner
   - Triggers React Query refetch

4. **Touch feedback**
   - `:active` states with subtle scale/opacity
   - Smooth 100ms transitions

---

## Dependencies to Add

```bash
pnpm add -D @vite-pwa/vite-plugin  # or manual SW approach
pnpm add @tanstack/react-virtual
pnpm add react-swipeable  # optional, for swipe gestures
```

---

## Implementation Order

Since doing all at once, suggested sequence within the work:

1. **PWA setup** (manifest, viewport, icons, service worker) - foundation everything else builds on
2. **Bottom navigation** - changes nav structure, do early
3. **Scanner overhaul** - core feature improvement
4. **Performance** (virtualization, batching, prefetch) - can be done in parallel with scanner
5. **Swipe gestures + pull-to-refresh** - polish layer on top

---

## Testing Checklist

- [ ] Add to Home Screen works on iOS Safari
- [ ] App launches in standalone mode (no Safari chrome)
- [ ] No pinch-to-zoom possible
- [ ] Scanner opens with camera immediately (after permission granted)
- [ ] Torch button toggles flashlight
- [ ] Scan beep plays on successful scan
- [ ] Bottom nav appears on mobile, hamburger on desktop
- [ ] Swipe left on card reveals delete
- [ ] Pull down on list triggers refresh
- [ ] List scrolling is smooth with 100+ items
- [ ] Location page makes 1 batch query, not 6+
- [ ] Route transitions show skeleton placeholders
