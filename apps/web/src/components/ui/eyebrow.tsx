import type { ElementType, ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The shared eyebrow label class. The look itself lives in the `eyebrow` CSS
 * utility (styles.css) — this constant is just its name, for `cn()` consumers.
 */
const EYEBROW_CLASS = "eyebrow";

/**
 * The mono eyebrow label, backed by the `eyebrow` CSS utility (see styles.css).
 * Renders a `<p>` by default; pass `as` for a span/div/th/label. Override
 * tracking/spacing/color via className (cn is twMerge-backed, so a later class
 * wins).
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
