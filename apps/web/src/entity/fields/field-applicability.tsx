/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The read-only tooltip explanation must be reachable by keyboard. */
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

/** An inapplicable value has an explanation, but no editing or suggestion affordance. */
export function NotApplicableField({ reason }: { reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="note"
            aria-label={`Not applicable. ${reason}`}
            className="text-muted-foreground"
          />
        }
      >
        —
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */
