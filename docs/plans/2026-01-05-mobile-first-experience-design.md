# First-Class Mobile Experience

**Goal:** Transform the web app into an iOS-native-feeling experience with PWA, improved scanner, better performance, and touch-friendly UX.

**Target:** iOS only (no Android considerations)

---

## 1. Service Worker (PWA Offline)
- Cache app shell + static assets for instant loads
- Currently PWA installs but doesn't work offline

## 2. Swipe Gestures
- Swipe-to-delete on inventory/product mobile cards
- Swipe left reveals delete action

## 3. Pull to Refresh
- Add pull-down gesture on list pages
- Rubber-band effect + spinner
- Triggers React Query refetch

## 4. Performance Optimizations
- **Batch location queries** - Replace per-card inventory queries with single batch (6 queries → 1)
- **Skeleton placeholders** - Show pulsing skeletons during `useTransition` pending state

---

## Dependencies

May need:
- `react-swipeable` (for swipe gestures)
- `@vite-pwa/vite-plugin` (for service worker, or manual SW approach)

---

## Testing Checklist

- [ ] Swipe left on card reveals delete
- [ ] Pull down on list triggers refresh
- [ ] Location page makes 1 batch query, not 6+
- [ ] Route transitions show skeleton placeholders
