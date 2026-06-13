import type { ElementType, ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The mono eyebrow label, one home: `font-mono text-2xs text-eyebrow uppercase
 * tracking-wider`. Override tracking/spacing via className (cn is twMerge-backed).
 */
export function Eyebrow({
  children,
  className,
  as: As = "p",
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
}) {
  return (
    <As
      className={cn(
        "font-mono text-2xs text-eyebrow uppercase tracking-wider",
        className,
      )}
    >
      {children}
    </As>
  );
}

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
      <h3 className={cn("mb-4 font-semibold text-xl", className)}>{label}</h3>
    );
  }
  return <Eyebrow className={className}>{label}</Eyebrow>;
}
