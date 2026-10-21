import type { WorkflowCommandRequest } from "@cubby/schemas/workflow-command";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { readPathValue } from "~/entity/read-path";
import { runHref } from "~/entity/routing/purchase-import-links";
import { workflowCommandOptions } from "~/integrations/tanstack-query/generated/catalog.gen";

/** One catalog-backed executor; mutation scope serializes actual operation effects. */
export function useWorkflowCommand(scope?: { id: string }) {
  const queryClient = useQueryClient();
  return useActionMutation({
    mutationFn: () => ({
      mutationFn: async (request: WorkflowCommandRequest) => {
        const declared = workflowCommandOptions(request.operation);
        const { command } = declared;
        const options = {
          mutationFn: declared.mutationFn,
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
