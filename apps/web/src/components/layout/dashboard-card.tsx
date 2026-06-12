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
 * Provides animated entrance, icon + title header, optional description and action.
 */
export function DashboardCard({
  icon: Icon,
  title,
  description,
  action,
  children,
}: DashboardCardProps) {
  return (
    <Card className="fade-in slide-in-from-bottom-2 flex animate-in flex-col duration-300">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5 text-eyebrow" />
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
