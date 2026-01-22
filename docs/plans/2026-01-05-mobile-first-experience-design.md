# First-Class Mobile Experience

**Goal:** Transform the web app into an iOS-native-feeling experience with PWA, improved scanner, better performance, and touch-friendly UX.

**Target:** iOS only (no Android considerations)

---

## 1. Service Worker (PWA Offline)
- Cache app shell + static assets for instant loads
- Currently PWA installs but doesn't work offline

## 2. Swipe Gestures
- Swipe-to-delete on inventory/product mobile cards
- `react-swipeable` is installed but unused
- Swipe left reveals delete action

## 3. Pull to Refresh
- Add pull-down gesture on list pages
- Rubber-band effect + spinner
- Triggers React Query refetch

## 4. Mobile Card Virtualization
- Desktop table is virtualized, mobile cards are not
- Wrap `MobileCardView` in virtualizer for large lists

## 5. Performance Optimizations
- **Batch location queries** - Replace per-card inventory queries with single batch (6 queries → 1)
- **Skeleton placeholders** - Show pulsing skeletons during `useTransition` pending state
- **Prefetch on touchstart** - Add `onTouchStart` prefetch to Link components (~100-200ms head start)
- **Lazy load images** - Add `loading="lazy"` to product/entity images in cards

## 6. Audio Feedback
- Play beep sound on successful scan (haptics limited on iOS web)

---

## Dependencies

Already installed:
- `@tanstack/react-virtual`
- `react-swipeable`

May need:
- `@vite-pwa/vite-plugin` (for service worker, or manual SW approach)

---

## Testing Checklist

- [ ] Scan beep plays on successful scan
- [ ] Swipe left on card reveals delete
- [ ] Pull down on list triggers refresh
- [ ] List scrolling is smooth with 100+ items (mobile cards)
- [ ] Location page makes 1 batch query, not 6+
- [ ] Route transitions show skeleton placeholders
