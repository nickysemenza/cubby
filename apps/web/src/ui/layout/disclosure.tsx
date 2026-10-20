import { Collapsible } from "@base-ui/react/collapsible";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Open state for a disclosure. Children mount only while open; `keepMounted`
 * is the caller's explicit acceptance of eager work. Drafts that must survive
 * closing belong to their form owner.
 */
export interface DisclosureState {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  keepMounted?: boolean;
}

/** Root shared with `Section`, whose heading row owns its own trigger layout. */
export function DisclosureRoot({
  state,
  className,
  children,
}: {
  state: DisclosureState;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root
      defaultOpen={state.defaultOpen ?? false}
      open={state.open}
      onOpenChange={(open) => state.onOpenChange?.(open)}
      className={className}
    >
      {children}
    </Collapsible.Root>
  );
}

/** The chevron and label; `data-panel-open` on the trigger turns the chevron. */
export function DisclosureTrigger({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Trigger
      className={cn(
        "group/disclosure -my-1 flex min-h-11 min-w-0 items-center gap-1.5 rounded-sm py-1 text-left outline-none hover:text-foreground-strong focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0",
        className,
      )}
    >
      <CaretRightIcon
        aria-hidden
        className="size-3 shrink-0 text-muted-foreground group-data-[panel-open]/disclosure:rotate-90"
      />
      <span className="min-w-0 break-words">{children}</span>
    </Collapsible.Trigger>
  );
}

export function DisclosureBody({
  keepMounted,
  className,
  children,
}: {
  keepMounted?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Panel keepMounted={keepMounted} className={className}>
      {children}
    </Collapsible.Panel>
  );
}

/**
 * One collapsible detail: a sentence-case summary row with a chevron, an
 * optional quiet `meta` (count, status) and `aside` controls that sit beside
 * the trigger rather than inside it, so using them never toggles the body.
 */
export function Disclosure({
  summary,
  meta,
  aside,
  className,
  children,
  ...state
}: DisclosureState & {
  summary: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <DisclosureRoot state={state} className={cn("min-w-0", className)}>
      <div
        data-slot="disclosure-summary"
        className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm font-medium text-foreground"
      >
        <DisclosureTrigger>{summary}</DisclosureTrigger>
        {meta != null && (
          <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
            {meta}
          </span>
        )}
        {aside != null && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {aside}
          </div>
        )}
      </div>
      <DisclosureBody keepMounted={state.keepMounted} className="pt-1 pl-4.5">
        {children}
      </DisclosureBody>
    </DisclosureRoot>
  );
}
