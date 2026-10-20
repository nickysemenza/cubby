import { Fragment, type ReactNode } from "react";

import { cn } from "~/lib/utils";

type PageHeaderProps = {
  title: ReactNode;
  /**
   * `stacked`: facts on their own line under the title (record details, Home).
   * `inline`: facts beside the title on one row (list and tool pages).
   */
  layout: "stacked" | "inline";
  /** Wayfinding above the title: a record's trail, a tool page's parent. */
  breadcrumb?: ReactNode;
  /** A small identity thumbnail beside the title block. */
  media?: ReactNode;
  /** One status chip beside the title. */
  status?: ReactNode;
  /**
   * Quiet facts joined by middots; a value the reader scans for is wrapped in
   * `<strong>` and reads in foreground weight ("Last purchase <strong>Oct
   * 12</strong>").
   */
  facts?: readonly ReactNode[];
  /** One muted sentence under the title (Home). */
  description?: ReactNode;
  /** Inline only: page-owned query tools between identity and actions. */
  tools?: ReactNode;
  /** Edit and one ink primary; anything further belongs in overflow. */
  actions?: ReactNode;
  /** Full-width content under the header: key numbers, saved-view tabs. */
  below?: ReactNode;
  className?: string;
  "data-testid"?: string;
};

/**
 * Every page's identity. The parts are optional; their look is not: a 20px
 * semibold title, a 12px facts line, actions on the right that wrap before
 * squeezing the title.
 */
export function PageHeader({
  title,
  layout,
  breadcrumb,
  media,
  status,
  facts,
  description,
  tools,
  actions,
  below,
  className,
  "data-testid": testId,
}: PageHeaderProps) {
  const factLine = facts?.length ? <FactLine facts={facts} /> : null;
  const actionGroup = actions != null && (
    <div className="flex max-w-full flex-wrap items-center gap-1.5 print:hidden">
      {actions}
    </div>
  );
  const heading = (
    <h1 className="min-w-0 text-xl/7 font-semibold break-words text-foreground-strong">
      {title}
    </h1>
  );
  if (layout === "inline") {
    return (
      <header
        data-slot="page-header"
        data-layout="inline"
        data-testid={testId}
        className={cn("min-w-0", className)}
      >
        {breadcrumb != null && (
          <div className="mb-1 text-xs/4.5 text-muted-foreground">
            {breadcrumb}
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div
            data-slot="page-header-identity"
            className="flex min-w-0 items-center gap-x-3"
          >
            {heading}
            {status}
            {factLine}
          </div>
          {tools != null && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 max-md:order-last max-md:basis-full md:min-w-64">
              {tools}
            </div>
          )}
          {actionGroup && <div className="ml-auto">{actionGroup}</div>}
        </div>
        {below}
      </header>
    );
  }
  return (
    <header
      data-slot="page-header"
      data-layout="stacked"
      data-testid={testId}
      className={cn("min-w-0", className)}
    >
      <div className="flex min-w-0 items-start gap-3">
        {media != null && <div className="shrink-0">{media}</div>}
        <div className="min-w-0 flex-1">
          {breadcrumb != null && (
            <div className="mb-1 text-xs/4.5 text-muted-foreground">
              {breadcrumb}
            </div>
          )}
          {/* Identity has a minimum basis so actions wrap before the title. */}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-[1_1_20rem] flex-wrap items-center gap-x-2 gap-y-1">
              {heading}
              {status}
            </div>
            {actionGroup && (
              <div className="max-sm:basis-full">{actionGroup}</div>
            )}
          </div>
          {factLine && <div className="mt-0.5">{factLine}</div>}
          {description != null && (
            <p className="text-sm/4.5 text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {below}
    </header>
  );
}

function FactLine({ facts }: { facts: readonly ReactNode[] }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center text-xs/4.5 text-muted-foreground [&_.money]:font-mono [&_strong]:font-semibold [&_strong]:text-foreground">
      {facts.map((fact, index) => (
        // Facts are positional; the caller's order is their identity.
        // eslint-disable-next-line react/no-array-index-key
        <Fragment key={index}>
          {index > 0 && (
            <span aria-hidden className="whitespace-pre">
              {" · "}
            </span>
          )}
          <span className="inline-flex min-w-0 items-center gap-1">{fact}</span>
        </Fragment>
      ))}
    </p>
  );
}
