import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";

interface SectionHeaderProps {
  title: string;
  count: number;
  color: string;
}

/**
 * Section header for grouped mobile lists.
 * Displays the group title with a count badge and an accent color background.
 */
export function SectionHeader({ title, count, color }: SectionHeaderProps) {
  return (
    <Row
      align="center"
      gap="sm"
      className="px-2 py-2"
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 8%, transparent)`,
      }}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="font-mono font-semibold text-2xs text-foreground/80 uppercase tracking-wider">
        {title}
      </span>
      <Badge
        variant="secondary"
        className="h-auto px-1.5 py-0.5 font-mono text-foreground/50 tabular-nums leading-none" /* tight */
      >
        {count}
      </Badge>
    </Row>
  );
}
