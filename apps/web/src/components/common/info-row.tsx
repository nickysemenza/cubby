import type { ReactNode } from "react";
import { Row } from "~/components/layout";
import { Eyebrow } from "~/components/ui/eyebrow";
import { NoneValue } from "~/components/ui/none-value";
import { cn } from "~/lib/utils";

interface InfoRowProps {
  label: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * One line of the entity "fact sheet", set like an index page: a mono eyebrow
 * label, a dotted leader, and the value flush right. The leader is the row's
 * own rule, so stacks of InfoRows need no dividers between them.
 */
export const InfoRow = ({
  label,
  children,
  action,
  className,
}: InfoRowProps) => (
  <Row align="baseline" gap="sm" className={cn("py-2", className)}>
    <Eyebrow as="span" className="shrink-0">
      {label}
    </Eyebrow>
    {/* Empty flex items baseline-align on their bottom border box edge, which
        lands the dots right on the text baseline. */}
    <span
      aria-hidden
      className="min-w-6 flex-1 border-border/80 border-b-2 border-dotted"
    />
    <Row
      as="span"
      align="center"
      justify="end"
      gap="tight"
      className="min-w-0 max-w-[65%] text-right text-sm"
    >
      <span className="min-w-0">{children ?? <NoneValue />}</span>
      {action}
    </Row>
  </Row>
);
