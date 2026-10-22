import { getErrorMessage } from "@cubby/shared";
import type {
  MutationFunction,
  UseMutationOptions,
} from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";

import type {
  EntityActionData,
  EntityActionVariables,
  EntityMutationPort,
} from "~/entity/editing/types";
import { useEntityActionCommands } from "~/entity/editing/use-entity-commands";
import type {
  EntityMutationOptionsFactory,
  StandardAction,
  StandardEntity,
} from "~/entity/entity-contracts";
import {
  mutationReceipt,
  settleReceiptProjection,
} from "~/integrations/tanstack-query/receipt-reconciliation";
import { showErrorToast } from "~/ui/feedback/error-details";

type ActionSuccess<TData> = ReactNode | ((data: TData) => ReactNode);
/**
 * A static string is a PREFIX, not the whole toast title: the shown title is
 * `${actionError}: ${getErrorMessage(error)}` so the raw message stays
 * visible even when the error carries no `diagnostics` (and so no Details
 * action). The factory form still returns the complete title verbatim.
 */
type ActionError<TError extends Error> = string | ((error: TError) => string);

function isActionSuccessFactory<TData>(
  value: ActionSuccess<TData>,
): value is (data: TData) => ReactNode {
  return typeof value === "function";
}

function isActionErrorFactory<TError extends Error>(
  value: ActionError<TError>,
): value is (error: TError) => string {
  return typeof value === "function";
}

interface ActionPresentation<TData, TError extends Error> {
  success?: ActionSuccess<TData>;
  successToastId?: string;
  /** Runs after acceptance; failures are reported separately from the saved write. */
  onSuccess?: (data: TData) => void | Promise<void>;
  /** See `ActionError` — a static string is a prefix, not the full title. */
  error?: ActionError<TError>;
}

function showSuccess<TData>(
  success: ActionSuccess<TData> | undefined,
  successToastId: string | undefined,
  onSuccess: ((data: TData) => void | Promise<void>) | undefined,
  data: TData,
) {
  if (success !== undefined) {
    toast.success(
      isActionSuccessFactory(success) ? success(data) : success,
      successToastId === undefined ? undefined : { id: successToastId },
    );
  }
  // Follow-up UI work cannot hold or fail an accepted write.
  try {
    void Promise.resolve(onSuccess?.(data)).catch((error) => {
      showErrorToast(error, "Saved, but follow-up work failed");
    });
  } catch (error) {
    showErrorToast(error, "Saved, but follow-up work failed");
  }
}

function showError<TError extends Error>(
  actionError: ActionError<TError> | undefined,
  error: TError,
) {
  showErrorToast(
    error,
    actionError === undefined
      ? getErrorMessage(error)
      : isActionErrorFactory(actionError)
        ? actionError(error)
        : `${actionError}: ${getErrorMessage(error)}`,
  );
}

/**
 * Common presentation around a transport-owned mutation. The zero-argument
 * factory retains its exact TanStack data/error/variables/context contract;
 * this hook owns only toast and caller-side success behavior.
 */
export function useActionMutation<
  TData,
  TError extends Error,
  TVariables,
  TContext,
>({
  mutationFn,
  ...presentation
}: ActionPresentation<TData, TError> & {
  mutationFn: () => UseMutationOptions<TData, TError, TVariables, TContext>;
}) {
  return useMutation({
    ...mutationFn(),
    onSuccess: (data) =>
      showSuccess(
        presentation.success,
        presentation.successToastId,
        presentation.onSuccess,
        data,
      ),
    onError: (error) => showError(presentation.error, error),
  });
}

type EntityActionExecutors<E extends StandardEntity> = {
  [A in StandardAction]: MutationFunction<
    EntityActionData<E, A>,
    EntityActionVariables<E, A>
  >;
};

function executorFor<E extends StandardEntity, A extends StandardAction>(
  executors: EntityActionExecutors<E>,
  operation: A,
) {
  return executors[operation];
}

/**
 * Registered CRUD mutations execute through semantic entity commands while
 * retaining the generated action's exact variables and projected result.
 */
export function useEntityActionMutation<
  E extends StandardEntity,
  A extends StandardAction,
>({
  mutationFn,
  entity,
  operation,
  intent = "capture",
  mutationPort,
  ...presentation
}: ActionPresentation<EntityActionData<E, A>, Error> & {
  mutationFn: EntityMutationOptionsFactory<E, A>;
  entity: E;
  operation: A;
  intent?: string;
  /** Test seam: a local operation adapter in place of the Start transport. */
  mutationPort?: EntityMutationPort;
}) {
  const queryClient = useQueryClient();
  const commands = useEntityActionCommands(entity, { mutationPort });
  const executors = {
    create: async (data) => await commands.createAction(data, intent),
    update: async (variables) => {
      const result = await commands.updateAction(variables, intent);
      await settleReceiptProjection(queryClient, mutationReceipt(result));
      return result;
    },
    delete: async (variables) => await commands.deleteAction(variables),
    bulkUpdate: async (variables) => await commands.bulkUpdateAction(variables),
  } satisfies EntityActionExecutors<E>;
  const execute = executorFor(executors, operation);
  const actionOptions = mutationFn();

  return useMutation<
    EntityActionData<E, A>,
    Error,
    EntityActionVariables<E, A>
  >({
    ...actionOptions,
    // The semantic command owns receipt reconciliation and invalidation.
    scope: undefined,
    meta: { entity },
    mutationFn: execute,
    onSuccess: (data) =>
      showSuccess(
        presentation.success,
        presentation.successToastId,
        presentation.onSuccess,
        data,
      ),
    onError: (error) => showError(presentation.error, error),
  });
}
