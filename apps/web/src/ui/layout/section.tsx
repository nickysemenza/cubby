import { type HTMLAttributes, type ReactNode, type Ref, useId } from "react";

import { cn } from "~/lib/utils";

import {
  DisclosureBody,
  DisclosureRoot,
  type DisclosureState,
  DisclosureTrigger,
} from "./disclosure";

type HeadingLevel = "h2" | "h3" | "h4";

type SectionHeading =
  | {
      title: ReactNode;
      /** The page outline decides the level; the look never changes with it. */
      headingAs: HeadingLevel;
    }
  | { title?: undefined; headingAs?: undefined };

type SectionProps = Omit<HTMLAttributes<HTMLElement>, "title"> &
  SectionHeading & {
    /** Quiet mono figure beside the title: the section's row count, 0 included. */
    count?: ReactNode;
    /** One-line takeaway under the heading (dashboards, analytics). */
    caption?: ReactNode;
    /** Quiet "+" or link; siblings of the disclosure trigger, never inside it. */
    actions?: ReactNode;
    /** 13px heading for sections nested inside another region. */
    compact?: boolean;
    /** Empty sections stay in the page with a secondary title. */
    empty?: boolean;
    /** Ruled rows start at the heading rule: no gap above the body. */
    ruled?: boolean;
    disclosure?: DisclosureState;
    ref?: Ref<HTMLElement>;
  };

/**
 * Every page, detail, dashboard and form region: a title with optional count
 * and actions over a hairline, an optional caption, then the body. A
 * disclosure defers its body until open.
 */
export function Section({
  title,
  headingAs: Heading = "h2",
  count,
  caption,
  actions,
  compact = false,
  empty = false,
  ruled = false,
  disclosure,
  className,
  children,
  ref,
  ...props
}: SectionProps) {
  const titleId = useId();
  const hasHeader = title != null || caption != null || actions != null;
  const heading = hasHeader && (
    <div
      data-slot="section-heading"
      className="flex flex-wrap items-center gap-x-3 border-b border-border pb-1.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {title != null && (
          <Heading
            id={titleId}
            className={cn(
              "flex min-w-0 font-semibold text-foreground",
              compact ? "text-sm/4.5" : "text-base/4.5",
              empty && "font-medium text-muted-foreground",
            )}
          >
            {disclosure ? (
              <DisclosureTrigger>{title}</DisclosureTrigger>
            ) : (
              title
            )}
          </Heading>
        )}
        {count != null && (
          <span className="font-mono text-xs/4.5 text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </div>
      {actions != null && (
        <div className="-my-1 flex max-w-full flex-wrap items-center gap-2 text-xs/4.5 text-muted-foreground [&>a]:inline-flex [&>a]:items-center [&>a]:hover:text-foreground [&>a]:hover:underline [&>a]:max-md:min-h-11">
          {actions}
        </div>
      )}
      {caption != null && (
        <p className="basis-full text-xs/4.5 text-muted-foreground">
          {caption}
        </p>
      )}
    </div>
  );
  const body = <div className="min-w-0 space-y-2 text-sm">{children}</div>;
  return (
    <section
      aria-labelledby={
        title != null && !props["aria-label"] ? titleId : undefined
      }
      className={cn(
        "flex min-w-0 flex-col",
        ruled ? "gap-0" : "gap-2",
        className,
      )}
      ref={ref}
      {...props}
    >
      {disclosure ? (
        <DisclosureRoot
          state={disclosure}
          className={cn("min-w-0", !ruled && "space-y-2")}
        >
          {heading}
          <DisclosureBody keepMounted={disclosure.keepMounted}>
            {body}
          </DisclosureBody>
        </DisclosureRoot>
      ) : (
        <>
          {heading}
          {body}
        </>
      )}
    </section>
  );
}
