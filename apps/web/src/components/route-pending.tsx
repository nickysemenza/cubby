import { useLocation, useParams } from "@tanstack/react-router";
import {
  completeNavLeaves,
  findActiveTo,
} from "~/app/_components/navigation/nav-items";
import {
  DashboardSectionLoading,
  DetailSpecPlateLoading,
} from "~/components/feedback/loading-skeletons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";

/** Router-wide default pending component (see `defaultPendingComponent`).
 * Shown during a route transition when the destination isn't ready yet — most
 * visibly on mobile, where there's no hover to preload the chunk before the tap.
 * Detail routes override this with `DetailPagePending`; ordinary routes retain
 * their destination name and the ruled dashboard/ledger cadence. */
export function RoutePending() {
  const pathname = useLocation().pathname;
  const activeTo = findActiveTo(pathname);
  const destination =
    completeNavLeaves.find((item) => item.to === activeTo)?.label ?? "Cubby";
  const label = `Loading ${destination.toLocaleLowerCase()}…`;

  return (
    <PageWrapper>
      <header className="border-b bg-card px-4 py-4">
        <h1 className="font-heading font-semibold text-2xl">{destination}</h1>
      </header>
      <DashboardSectionLoading label={label} />
    </PageWrapper>
  );
}

/** Standard pending/loading component for detail pages. Mirrors the real
 * ruled specification plate so the transition retains record identity. */
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
  const label = shortcode
    ? `Loading ${shortcode} details…`
    : "Loading record details…";

  return (
    <PageWrapper>
      <DetailSpecPlateLoading label={label} />
    </PageWrapper>
  );
}
