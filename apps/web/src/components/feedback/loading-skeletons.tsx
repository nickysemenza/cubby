import type { ReactNode } from "react";

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
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_4rem] items-center gap-2 border-b border-border py-2">
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
        <SkeletonLedgerRow key={i} index={i} />
      ))}
    </div>
  );
}

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A status region with flow-content skeletons cannot use the phrasing-only output element. */
function FlowContentStatus({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={className}
    >
      {children}
    </div>
  );
}
/* oxlint-enable jsx-a11y/prefer-tag-over-role */

/** Labelled rows for lists, tables, and other ledger-shaped destinations. */
function LedgerRowsLoading({
  label,
  count = 6,
}: {
  label: string;
  count?: number;
}) {
  return (
    <FlowContentStatus label={label} className="border border-border bg-card">
      {/* Page renders the actual identity before this Suspense fallback. This
          band stands in for the list's toolbar instead of repeating a second
          title-shaped block beneath it. */}
      <div className="flex h-10 items-center border-b bg-muted/40 px-4">
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="px-4">
        <SkeletonGrid count={count} />
      </div>
    </FlowContentStatus>
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
    <FlowContentStatus label={label}>
      <div className="border border-border bg-card px-4 py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Skeleton className="mt-2 h-8 w-64 max-w-full" />
      </div>
      <div className="grid border-x border-border sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="border-b border-border p-4 sm:odd:border-r"
          >
            <Skeleton className="mb-2 h-2.5 w-20" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ))}
      </div>
    </FlowContentStatus>
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
    <FlowContentStatus label={label}>
      <p className="border border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        {label}
      </p>
      <div className="divide-y divide-border border-x border-b border-border">
        {Array.from({ length: sections }, (_, index) => (
          <section key={index} className="p-4" aria-hidden="true">
            <Skeleton className="mb-4 h-3 w-32" />
            <SkeletonGrid count={index === sections - 1 ? 4 : 2} />
          </section>
        ))}
      </div>
    </FlowContentStatus>
  );
}

// Simple loading text with spinner for inline use
export function SimpleLoading({ text = "Loading..." }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
      <Spinner />
      {text}
    </div>
  );
}
