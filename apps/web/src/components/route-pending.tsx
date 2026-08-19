import { useLocation, useParams } from "@tanstack/react-router";
import {
  completeNavLeaves,
  findActiveTo,
} from "~/app/_components/navigation/nav-items";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";

function PendingBar({ className }: { className: string }) {
  return <div className={`animate-pulse bg-muted ${className}`} />;
}

function PendingLedger({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <p className="border-b-[3px] border-b-foreground bg-card px-4 py-2 font-mono text-2xs text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <div className="divide-y divide-border border-border border-x border-b">
        {[2, 2, 4].map((rows, section) => (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: static loading regions
            key={section}
            className="p-4"
            aria-hidden="true"
          >
            <PendingBar className="mb-4 h-3 w-32" />
            {Array.from({ length: rows }, (_, row) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static loading rows
                key={row}
                className="grid grid-cols-[3.5rem_minmax(0,1fr)_4rem] items-center gap-2 border-border border-b border-dashed py-2"
              >
                <PendingBar className="h-3 w-full" />
                <PendingBar
                  className={row % 2 === 0 ? "h-2.5 w-3/5" : "h-3 w-2/5"}
                />
                <PendingBar className="h-3 w-full" />
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function PendingDetailPlate({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <div className="border-b-[3px] border-b-foreground bg-card px-4 py-2">
        <p className="font-mono text-2xs text-muted-foreground uppercase tracking-wider">
          {label}
        </p>
        <PendingBar className="mt-2 h-8 w-64 max-w-full" />
      </div>
      <div className="grid border-border border-x sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static loading plate
            key={index}
            className="border-border border-b p-4 sm:odd:border-r"
          >
            <PendingBar className="mb-2 h-2.5 w-20" />
            <PendingBar className="h-4 w-3/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

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
      <header className="border-b-[3px] border-b-foreground bg-card px-4 py-4">
        <h1 className="font-heading font-semibold text-2xl">{destination}</h1>
      </header>
      <PendingLedger label={label} />
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
      <PendingDetailPlate label={label} />
    </PageWrapper>
  );
}
