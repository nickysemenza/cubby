import { Eyebrow } from "~/components/ui/eyebrow";
import { cn } from "~/lib/utils";

/**
 * A recipe section heading with the shared "show when >1 section or named"
 * condition and "Part N" fallback, so every view stays in sync. `variant`
 * picks the eyebrow label (ingredient ledger, preview) vs the serif title
 * (method/instructions). Returns null when the heading should be hidden.
 */
export function SectionHeading({
  sectionName,
  index,
  total,
  variant = "eyebrow",
  className,
}: {
  sectionName?: string | null;
  index: number;
  total: number;
  variant?: "eyebrow" | "title";
  className?: string;
}) {
  if (!(total > 1 || sectionName)) return null;
  const label = sectionName || `Part ${index + 1}`;
  if (variant === "title") {
    return (
      <h3 className={cn("mb-4 text-xl font-semibold", className)}>{label}</h3>
    );
  }
  return <Eyebrow className={className}>{label}</Eyebrow>;
}
