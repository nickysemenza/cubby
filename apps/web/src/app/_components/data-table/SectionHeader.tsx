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
    <div
      className="flex items-center gap-2 px-2 py-1.5"
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 8%, transparent)`,
      }}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="font-semibold text-foreground/80 text-xs capitalize">
        {title}
      </span>
      <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 font-medium text-[10px] text-foreground/50 leading-none">
        {count}
      </span>
    </div>
  );
}
