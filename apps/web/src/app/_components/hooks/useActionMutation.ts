import type {
  MutationFunction,
  UseMutationOptions,
} from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { showErrorToast } from "~/components/feedback/error-details";
import type {
  EntityActionData,
  EntityActionVariables,
  EntityMutationPort,
} from "~/entities/editing/types";
import { useEntityActionCommands } from "~/entities/editing/use-entity-commands";
import type {
  EntityMutationOptionsFactory,
  StandardAction,
  StandardEntity,
} from "~/entities/entity-contracts";
import { getErrorMessage } from "~/lib/error-utils";

/** Mutation factories are callable without callbacks; the hook composes those itself. */
type MutationOptionsFn = () => object;

/** The mutation's success-result type, recovered from the options it produces. */
export type DataOf<TFn extends MutationOptionsFn> =
  ReturnType<TFn> extends UseMutationOptions<infer TData, infer _E, infer _V>
    ? TData
    : never;
/** The mutation's input/variables type, recovered from the options it produces. */
export type VariablesOf<TFn extends MutationOptionsFn> =
  ReturnType<TFn> extends UseMutationOptions<
    infer _D,
    infer _E,
    infer TVariables
  >
    ? TVariables
    : never;

type ActionSuccess<TData> = ReactNode | ((data: TData) => ReactNode);
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
  onSuccess?: (data: TData) => void;
  error?: ActionError<TError>;
}

function showSuccess<TData>(
  success: ActionSuccess<TData> | undefined,
  successToastId: string | undefined,
  onSuccess: ((data: TData) => void) | undefined,
  data: TData,
) {
  if (success !== undefined) {
    toast.success(
      isActionSuccessFactory(success) ? success(data) : success,
      successToastId === undefined ? undefined : { id: successToastId },
    );
  }
  onSuccess?.(data);
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
        : actionError,
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
  const commands = useEntityActionCommands(entity, { mutationPort });
  const executors = {
    create: async (data) => await commands.createAction(data, intent),
    update: async (variables) => await commands.updateAction(variables, intent),
    delete: async (variables) => await commands.deleteAction(variables),
    bulkUpdate: async (variables) => await commands.bulkUpdateAction(variables),
  } satisfies EntityActionExecutors<E>;
  const execute = executorFor(executors, operation);

  return useMutation<
    EntityActionData<E, A>,
    Error,
    EntityActionVariables<E, A>
  >({
    ...mutationFn(),
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
