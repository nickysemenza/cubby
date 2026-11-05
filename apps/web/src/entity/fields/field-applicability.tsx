/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The read-only tooltip explanation must be reachable by keyboard. */
import { cn } from "cn";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { NONE_VALUE_TONE } from "~/ui/text/none-value";

/**
 * An inapplicable value is a named state: it reads "N/A" in the empty mark's
 * tone, even in a table cell that blanks plain absence, and explains why.
 */
export function NotApplicableField({ reason }: { reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="note"
            aria-label={`Not applicable. ${reason}`}
            className={cn(NONE_VALUE_TONE, "select-none")}
          />
        }
      >
        N/A
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */
