import type { Icon } from "@phosphor-icons/react/lib";

import {
  Empty,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/ui/primitives/empty";

/**
 * Compact empty state for chart cards. Uses Empty's minimal variant so it
 * sits inside an existing Card without doubling borders/padding.
 */
export function ChartEmpty({ icon, title }: { icon?: Icon; title: string }) {
  return (
    <Empty variant="minimal" className="py-6">
      <EmptyHeader>
        {icon && <EmptyIcon icon={icon} />}
        <EmptyTitle className="text-muted-foreground">{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
