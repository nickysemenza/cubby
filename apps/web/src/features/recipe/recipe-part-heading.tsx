import { cn } from "~/lib/utils";

/**
 * A recipe part's name, shown when a recipe has more than one part or names
 * its only one, with a "Part N" fallback, so every recipe view stays in sync.
 * Returns null when the heading should be hidden.
 */
export function RecipePartHeading({
  sectionName,
  index,
  total,
  className,
}: {
  sectionName?: string | null;
  index: number;
  total: number;
  className?: string;
}) {
  if (!(total > 1 || sectionName)) return null;
  return (
    <h3 className={cn("text-sm/4.5 font-semibold text-foreground", className)}>
      {sectionName || `Part ${index + 1}`}
    </h3>
  );
}
