import {
  INGREDIENT_PART_COLOR,
  type IngredientPart,
} from "~/lib/ingredient-part-colors";
import { cn } from "~/lib/utils";
import { InlineTextDiff } from "./inline-text-diff";

type DriftAxis = IngredientPart;

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
      style={{ borderBottomColor: INGREDIENT_PART_COLOR[axis] }}
      title={axis}
    >
      <InlineTextDiff before={before} after={after} />
    </span>
  );
}
