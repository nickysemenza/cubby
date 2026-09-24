import type { Icon } from "@phosphor-icons/react/lib";
import { Link, type LinkComponentProps } from "@tanstack/react-router";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { cn } from "~/lib/utils";

/**
 * The drill-through link in a dashboard card's header ("LEDGER", "INVENTORY").
 *
 * Exists to own the touch target: as six hand-rolled `text-2xs` links these
 * measured 14px tall on a phone, against DESIGN.md's 40–48px phone-control
 * floor — and they are each card's primary way out to the full record. The
 * mono eyebrow look is unchanged; only the hit area grows, and only where
 * there is no pointer.
 */
export function CardActionLink({
  className,
  ...props
}: LinkComponentProps<"a">) {
  return (
    <Link
      className={cn(
        "-mr-1 inline-flex min-h-11 shrink-0 items-center px-1 font-mono text-2xs text-muted-foreground uppercase transition-colors hover:text-foreground sm:mr-0 sm:min-h-0 sm:px-0",
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
    <Card className="flex flex-col">
      <CardHeader className="border-b border-border pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="size-3.5 shrink-0 text-slate" />
            <CardTitle as={titleAs}>{title}</CardTitle>
          </div>
          {action}
        </div>
        {description && (
          <CardDescription className="text-xs">{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}
