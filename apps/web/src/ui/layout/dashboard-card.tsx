import type { Icon } from "@phosphor-icons/react/lib";
import { Link, type LinkComponentProps } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { Card, CardContent } from "~/ui/primitives/card";

import { SectionHeading } from "./section";

/** Dashboard drill-through links retain a 44px phone target even in compact headings. */
export function CardActionLink({
  className,
  ...props
}: LinkComponentProps<"a">) {
  return (
    <Link
      className={cn(
        "-mr-1 inline-flex min-h-11 shrink-0 items-center rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground sm:mr-0 sm:min-h-0 sm:px-0",
        className,
      )}
      {...props}
    />
  );
}

interface DashboardCardProps {
  icon: Icon;
  title: string;
  description?: string;
  /** Optional action element (e.g., "View all" link) displayed in header */
  action?: React.ReactNode;
  /**
   * Heading level for the card title. Dashboard cards are named regions of the
   * page, so they default to `h3` under the enclosing `Section`'s `h2` — a
   * dashboard whose titles are all `div`s exposes no outline to skip through.
   */
  titleAs?: "h2" | "h3" | "h4";
  children: React.ReactNode;
}

/**
 * Consistent card wrapper for dashboard/home page widgets.
 * Provides icon + title header, optional description and action.
 * Deliberately no entrance animation: it gated content visibility on an
 * animation frame (blank cards on hidden/headless tabs), and the product
 * register bans orchestrated page-load sequences anyway.
 */
export function DashboardCard({
  icon: Icon,
  title,
  description,
  action,
  titleAs = "h3",
  children,
}: DashboardCardProps) {
  return (
    <Card className="gap-2 rounded-none border-0 bg-transparent p-0 shadow-none">
      <SectionHeading
        as={titleAs}
        title={
          <>
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            {title}
          </>
        }
        description={description}
        actions={action}
      />
      <CardContent className="flex-1 px-2">{children}</CardContent>
    </Card>
  );
}
