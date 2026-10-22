import type { WorkflowCommandRequest } from "@cubby/schemas/workflow-command";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { readPathValue } from "~/entity/read-path";
import { runHref } from "~/entity/routing/purchase-import-links";
import { loadWorkflowCommandOptions } from "~/integrations/tanstack-query/generated/commands.gen";
import { showErrorToast } from "~/ui/feedback/error-details";

/** One catalog-backed executor; mutation scope serializes actual operation effects. */
export function useWorkflowCommand({
  scope,
  onResult,
}: {
  scope?: { id: string };
  onResult?: (value: {
    request: WorkflowCommandRequest;
    result: unknown;
  }) => void | Promise<void>;
} = {}) {
  const queryClient = useQueryClient();
  return useActionMutation({
    mutationFn: () => ({
      mutationFn: async (request: WorkflowCommandRequest) => {
        const declared = await loadWorkflowCommandOptions(request.operation);
        const { command } = declared;
        const options = {
          mutationFn: async (body: WorkflowCommandRequest["body"]) => {
            const result = await declared.mutationFn(body);
            try {
              // Synchronous receipt patches precede invalidation; follow-up work
              // cannot turn an accepted transport write into a retryable failure.
              const followUp = onResult?.({ request, result });
              if (followUp)
                void followUp.catch((error: unknown) =>
                  showErrorToast(error, "Saved, but follow-up work failed"),
                );
            } catch (error) {
              showErrorToast(error, "Saved, but follow-up work failed");
            }
            return result;
          },
          mutationKey: declared.mutationKey,
          meta: declared.meta,
          scope,
          onError: () => undefined,
        };
        // The inner mutation retains the operation's meta, so the existing global cache ripple
        // and side-effect handling observe the actual operation and exact submitted body.
        const result = await queryClient
          .getMutationCache()
          .build(queryClient, options)
          .execute(request.body);
        const successor = command.navigateRunPath
          ? readPathValue(result, command.navigateRunPath)
          : undefined;
        if (typeof successor === "string")
          window.location.assign(runHref(successor));
        const facts = (command.resultFields ?? []).flatMap((field) => {
          const value = readPathValue(result, field.path);
          return typeof value === "string" || typeof value === "number"
            ? [`${field.label}: ${value}`]
            : [];
        });
        const message = facts.length ? facts.join("; ") : undefined;
        if (typeof message === "string" || command.success)
          toast.success(
            typeof message === "string" ? message : command.success,
          );
        return { request, result };
      },
    }),
    error: "Could not run command",
  });
}
