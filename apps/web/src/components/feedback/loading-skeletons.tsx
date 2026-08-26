import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

/**
 * One loading row shaped like the dense record surface it becomes. Widths vary
 * by index so the column doesn't read as a barcode.
 */
function SkeletonLedgerRow({ index }: { index: number }) {
  const nameWidths = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-1/3"];
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_4rem] items-center gap-2 border-border border-b py-2">
      <Skeleton className="h-3 w-full" />
      <Skeleton className={cn("h-3", nameWidths[index % nameWidths.length])} />
      <Skeleton className="h-3 w-full" />
    </div>
  );
}

function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list that never reorders
        <SkeletonLedgerRow key={i} index={i} />
      ))}
    </div>
  );
}

/** Labelled rows for lists, tables, and other ledger-shaped destinations. */
function LedgerRowsLoading({
  label,
  count = 6,
}: {
  label: string;
  count?: number;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="border border-border bg-card"
    >
      {/* Page renders the actual identity before this Suspense fallback. This
          band stands in for the list's toolbar instead of repeating a second
          title-shaped block beneath it. */}
      <div className="flex h-10 items-center border-b bg-muted/40 px-4">
        <span className="text-muted-foreground text-xs">{label}</span>
      </div>
      <div className="px-4">
        <SkeletonGrid count={count} />
      </div>
    </div>
  );
}

/** Default list fallback. Known destinations should pass task-specific copy. */
export function ListLoadingSkeleton({
  count = 6,
  label = "Loading records…",
}: {
  count?: number;
  label?: string;
}) {
  return <LedgerRowsLoading label={label} count={count} />;
}

/** Detail transition shaped like the destination's ruled specification plate. */
export function DetailSpecPlateLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <div className="border border-border bg-card px-4 py-3">
        <p className="text-muted-foreground text-xs">{label}</p>
        <Skeleton className="mt-2 h-8 w-64 max-w-full" />
      </div>
      <div className="grid border-border border-x sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static loading plate
            key={index}
            className="border-border border-b p-4 sm:odd:border-r"
          >
            <Skeleton className="mb-2 h-2.5 w-20" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Dashboard transition that preserves the cadence of named ruled sections. */
export function DashboardSectionLoading({
  label,
  sections = 3,
}: {
  label: string;
  sections?: number;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <p className="border border-border bg-muted/40 px-4 py-2 text-muted-foreground text-xs">
        {label}
      </p>
      <div className="divide-y divide-border border-border border-x border-b">
        {Array.from({ length: sections }, (_, index) => (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: static loading regions
            key={index}
            className="p-4"
            aria-hidden="true"
          >
            <Skeleton className="mb-4 h-3 w-32" />
            <SkeletonGrid count={index === sections - 1 ? 4 : 2} />
          </section>
        ))}
      </div>
    </div>
  );
}

// Simple loading text with spinner for inline use
export function SimpleLoading({ text = "Loading..." }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-4 text-muted-foreground text-xs">
      <Spinner />
      {text}
    </div>
  );
}
