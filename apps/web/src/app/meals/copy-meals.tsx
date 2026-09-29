import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Button } from "~/components/ui/button";
import { meal } from "~/integrations/tanstack-query/generated/catalog.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";

const shiftDays = (date: string, days: number) => {
  const shifted = parsePlainDate(date);
  shifted.setDate(shifted.getDate() + days);
  return formatPlainDate(shifted);
};

/**
 * Copies the previous seven days of meals onto the week that starts at
 * `weekStart`. Copies are plans appended to what is already there: eaters'
 * portions come across as planned, and nothing is logged or recounted.
 */
export function CopyLastWeekButton({ weekStart }: { weekStart: string }) {
  const copy = useActionMutation({
    mutationFn: () => meal.copyRange.mutationOptions(),
    success: ({ copied }) =>
      copied === 0
        ? "Nothing was planned last week"
        : `Copied ${copied} meal${copied === 1 ? "" : "s"} from last week`,
    error: (error) => getErrorMessage(error) || "Failed to copy last week",
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={copy.isPending}
      onClick={() =>
        copy.mutate({
          from: shiftDays(weekStart, -7),
          to: shiftDays(weekStart, -1),
          targetFrom: weekStart,
        })
      }
    >
      <CopyIcon />
      Copy last week
    </Button>
  );
}

/** Copies one meal as a new plan on the same day. */
export function DuplicateMealButton({
  mealId,
  onDuplicated,
}: {
  mealId: string;
  onDuplicated?: () => void;
}) {
  const duplicate = useActionMutation({
    mutationFn: () => meal.duplicate.mutationOptions(),
    success: "Meal duplicated",
    error: (error) => getErrorMessage(error) || "Failed to duplicate meal",
    onSuccess: () => onDuplicated?.(),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={duplicate.isPending}
      // SAFETY: a meal calendar item's id is its meal shortcode.
      onClick={() => duplicate.mutate({ mealId: mealId as never })}
    >
      <CopyIcon />
      Duplicate
    </Button>
  );
}
