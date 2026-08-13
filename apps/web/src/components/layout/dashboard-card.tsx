import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

interface DashboardCardProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional action element (e.g., "View all" link) displayed in header */
  action?: React.ReactNode;
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
  children,
}: DashboardCardProps) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="border-border border-b pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="size-3.5 text-slate" />
            <CardTitle>{title}</CardTitle>
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
