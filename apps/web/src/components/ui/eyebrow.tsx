import type { ElementType, ReactNode } from "react";
import { cn } from "~/lib/utils";

/** The shared eyebrow label classes — the one source for the mono caption look. */
export const EYEBROW_CLASS =
  "font-mono text-2xs text-eyebrow uppercase tracking-wider";

/**
 * The mono eyebrow label, one home: {@link EYEBROW_CLASS}. Renders a `<p>` by
 * default; pass `as` for a span/div/th/label. Override tracking/spacing/color via
 * className (cn is twMerge-backed, so a later class wins).
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
  return <As className={cn(EYEBROW_CLASS, className)}>{children}</As>;
}
