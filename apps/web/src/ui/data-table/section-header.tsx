import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";

import { cn } from "~/lib/utils";

interface SectionHeaderProps {
  title: string;
  count: number;
  /** "Filter to this": present only when the grouped field has a declared filter. */
  onFilter?: () => void;
  className?: string;
}

/**
 * Header of one grouped-list section: a neutral band with the section's
 * label and its count over the whole filtered set. "Filter to this" reveals on
 * hover and stays reachable by keyboard.
 */
export function SectionHeader({
  title,
  count,
  onFilter,
  className,
}: SectionHeaderProps) {
  return (
    <div
      data-slot="list-section-header"
      className={cn(
        "group/section flex min-h-8 items-center gap-2 border-b bg-muted px-3 py-1.5",
        className,
      )}
    >
      <h3 className="min-w-0 truncate text-[0.8125rem] font-semibold">
        {title}
      </h3>
      <span className="text-xs text-muted-foreground tabular-nums">
        {count}
      </span>
      {onFilter ? (
        <button
          type="button"
          onClick={onFilter}
          className="ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/section:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:opacity-100"
        >
          <FunnelIcon aria-hidden className="size-3.5" />
          Filter to this
          <span className="sr-only">: {title}</span>
        </button>
      ) : null}
    </div>
  );
}
