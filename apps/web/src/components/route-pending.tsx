import { useParams } from "@tanstack/react-router";
import { Stack } from "~/components/layout";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";

/** Router-wide default pending component (see `defaultPendingComponent`).
 * Shown during a route transition when the destination isn't ready yet — most
 * visibly on mobile, where there's no hover to preload the chunk before the tap.
 * Detail routes override this with `DetailPagePending`; this neutral header +
 * content blocks reads as "loading" on any other route without implying a shape. */
export function RoutePending() {
  return (
    <PageWrapper>
      <Stack gap="lg">
        <Stack gap="sm">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-56" />
        </Stack>
        <Stack gap="md">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </Stack>
      </Stack>
    </PageWrapper>
  );
}

/** Standard pending/loading component for detail pages.
 * Mirrors the real detail layout (eyebrow + title, then a 2-column card grid)
 * so the transition into the loaded page doesn't jump. */
export function DetailPagePending() {
  // The tab title too, not just the layout. TanStack runs a route's `head`
  // AFTER its loader resolves, so during a cold detail navigation the pending
  // match contributes no title and `HeadContent` falls back to the root default
  // — a ~2s window of a bare "Cubby". The shortcode is in the params already,
  // so the pending page can say what it's loading. `strict: false` because this
  // component is shared across every detail route (and `$id` ones have no
  // `shortcode` param at all).
  const { shortcode } = useParams({ strict: false });
  useDocumentTitle(shortcode);

  return (
    <PageWrapper>
      <div className="space-y-4 sm:space-y-6">
        {/* Header: eyebrow + title */}
        <Stack gap="sm">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-64" />
        </Stack>
        {/* 2-column card grid */}
        <div className="grid gap-4 sm:gap-6 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </PageWrapper>
  );
}
