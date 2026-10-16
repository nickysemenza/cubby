import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import {
  useId,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "~/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/ui/primitives/collapsible";

type HeadingLevel = "h2" | "h3" | "h4";

/** One compact heading band, with actions outside any disclosure trigger. */
export function SectionHeading({
  title,
  description,
  actions,
  meta,
  icon,
  as: Heading = "h2",
  id,
  muted = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  as?: HeadingLevel;
  id?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-sm border-b border-border/60 bg-muted/60 px-2 py-1">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {title && (
            <Heading
              id={id}
              className={cn(
                "flex min-w-0 items-center gap-2 text-[0.8125rem] font-semibold",
                muted && "text-muted-foreground",
              )}
            >
              {icon && (
                <span
                  aria-hidden
                  className="shrink-0 text-muted-foreground [&>svg]:size-3.5"
                >
                  {icon}
                </span>
              )}
              {title}
            </Heading>
          )}
          {meta && (
            <div className="min-w-0 text-xs text-muted-foreground tabular-nums">
              {meta}
            </div>
          )}
        </div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

interface SectionDisclosure {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Keep child-local state only when the caller deliberately accepts eager work. */
  keepMounted?: boolean;
}

interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  headingAs?: HeadingLevel;
  disclosure?: SectionDisclosure;
  ref?: Ref<HTMLElement>;
}

/**
 * Dense page, dashboard and form region. A disclosure defers its descendants
 * until open; form values that must survive closing belong to the form owner.
 */
export function Section({
  title,
  description,
  icon,
  meta,
  actions,
  headingAs = "h2",
  disclosure,
  className,
  children,
  ref,
  ...props
}: SectionProps) {
  const titleId = useId();
  const [localOpen, setLocalOpen] = useState(disclosure?.defaultOpen ?? false);
  const open = disclosure?.open ?? localOpen;
  const changeOpen = (next: boolean) => {
    setLocalOpen(next);
    disclosure?.onOpenChange?.(next);
  };
  const header = (title || description || meta || actions) && (
    <SectionHeading
      id={titleId}
      as={headingAs}
      title={
        disclosure ? (
          <CollapsibleTrigger className="-my-1 -ml-2 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left hover:text-primary focus-visible:outline-2 focus-visible:outline-ring sm:min-h-0">
            <CaretRightIcon
              aria-hidden
              className={cn("size-3 shrink-0", open && "rotate-90")}
            />
            <span className="min-w-0 break-words">{title}</span>
          </CollapsibleTrigger>
        ) : (
          title
        )
      }
      description={description}
      icon={icon}
      meta={meta}
      actions={actions}
    />
  );
  const body = (
    <div className="min-w-0 space-y-2 px-2 text-xs/relaxed">{children}</div>
  );
  return (
    <section
      aria-labelledby={title && !props["aria-label"] ? titleId : undefined}
      className={cn("flex min-w-0 flex-col gap-2", className)}
      ref={ref}
      {...props}
    >
      {disclosure ? (
        <Collapsible
          open={open}
          onOpenChange={changeOpen}
          className="min-w-0 space-y-2"
        >
          {header}
          <CollapsibleContent keepMounted={disclosure.keepMounted}>
            {open || disclosure.keepMounted ? body : null}
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <>
          {header}
          {body}
        </>
      )}
    </section>
  );
}
