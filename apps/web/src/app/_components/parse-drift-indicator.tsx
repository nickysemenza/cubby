import { cn } from "~/lib/utils";
import { InlineTextDiff } from "./inline-text-diff";

type DriftAxis = "amount" | "name" | "modifier";

// One underline color per part of the "amount name modifier" display format. The
// colored underline identifies *which* section a diff belongs to — replacing inline
// text labels like "mod:". Colors live as CSS tokens (styles.css) so the rich-text
// ingredient display can reuse them.
const AXIS_COLOR: Record<DriftAxis, string> = {
  amount: "var(--ingredient-amount)",
  name: "var(--ingredient-name)",
  modifier: "var(--ingredient-modifier)",
};

/**
 * One parser-drift axis, rendered identically everywhere (ingredient detail table,
 * recipe editor, problems panel): the red/green word diff of before→after, with a
 * colored underline marking which part it is. All axes are equal — no icon, no priority;
 * the underline color is the only section label.
 */
export function DriftIndicator({
  axis,
  before,
  after,
  className,
}: {
  axis: DriftAxis;
  before: string;
  after: string;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-block border-b-2 pb-px", className)}
      style={{ borderBottomColor: AXIS_COLOR[axis] }}
      title={axis}
    >
      <InlineTextDiff before={before} after={after} />
    </span>
  );
}
