import { countLabel } from "@cubby/shared/pluralize";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import type { JobSetFilter } from "~/contracts/job.contract";
import { job } from "~/integrations/tanstack-query/generated/catalog/job.gen";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Button } from "~/ui/primitives/button";

export function RetryJobsButton({
  filter,
  disabled = false,
  label = "Retry now",
}: {
  filter: JobSetFilter;
  disabled?: boolean;
  label?: string;
}) {
  const retry = useMutation(
    job.retryNow.mutationOptions({
      onSuccess: ({ retried }) =>
        toast.success(`Retry now: ${countLabel(retried, "Job")} made due`),
      onError: (error) => showErrorToast(error, "Retry now failed"),
    }),
  );
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || retry.isPending}
      onClick={() => retry.mutate({ filter })}
    >
      {retry.isPending ? "Retrying…" : label}
    </Button>
  );
}
