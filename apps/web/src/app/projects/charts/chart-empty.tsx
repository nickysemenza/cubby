import type { LucideIcon } from "lucide-react";

import {
  Empty,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";

/**
 * Compact empty state for chart cards. Uses Empty's minimal variant so it
 * sits inside an existing Card without doubling borders/padding.
 */
export function ChartEmpty({
  icon,
  title,
}: {
  icon?: LucideIcon;
  title: string;
}) {
  return (
    <Empty variant="minimal" className="py-6">
      <EmptyHeader>
        {icon && <EmptyIcon icon={icon} />}
        <EmptyTitle className="text-muted-foreground">{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
