import type { UseMutationOptions } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";

import type { EditableEntity } from "~/entities/editing/types";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { getErrorMessage } from "~/lib/error-utils";

/** A mutation-options factory supplied by either Start or a specialized transport. */
export type MutationOptionsFn = (opts: never) => UseMutationOptions<
  // oxlint-disable-next-line typescript/no-explicit-any -- positions only used as inference anchors
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- positions only used as inference anchors
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- positions only used as inference anchors
  any
>;

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

/**
 * The common write-mutation shape: on success toast a message (optionally
 * derived from the result), and run any side effect (close a dialog, resolve a
 * value, navigate); on error toast a message. `TData`/`TVariables` are inferred
 * from the passed `*.mutationOptions` reference, so callers need no generics.
 *
 * Invalidation is deliberately NOT a parameter. The operation descriptor behind
 * `mutationFn` declares what its write moves, and the root `MutationCache`
 * acts on it — including the re-invalidation once any background batch the
 * write enqueued drains. A per-call-site key list could only restate that, or
 * silently disagree with it.
 *
 * For the fixed "{Entity} updated" toast use {@link useUpdateMutation}; for the
 * Problems-page "fix all" buttons use `useProblemBackfill`.
 */
export function useActionMutation<TFn extends MutationOptionsFn>({
  mutationFn,
  success,
  successToastId,
  onSuccess,
  error,
  entity,
  operation = "create",
  intent = "capture",
}: {
  mutationFn: TFn;
  /**
   * Success toast — a fixed message or one derived from the result. Omit to skip
   * the toast entirely (for silent-invalidation or caller-toast flows); the
   * invalidation, background-batch re-invalidation, and `onSuccess` still run.
   */
  success?: ReactNode | ((data: DataOf<TFn>) => ReactNode);
  /**
   * Stable sonner toast id — repeated successes replace the same toast instead
   * of stacking. Load-bearing for range cell-paste, where every applied cell
   * fires this mutation's toast: N pastes collapse into one refreshing toast
   * next to the paste-summary toast.
   */
  successToastId?: string;
  /** Side effect after the toast (close dialog, resolve, navigate). */
  onSuccess?: (data: DataOf<TFn>) => void;
  /** Error toast — defaults to `getErrorMessage(err)`. */
  error?: string | ((err: unknown) => string);
  /** Route ordinary CRUD through the entity editing command lifecycle. */
  entity?: EditableEntity;
  operation?: "create" | "update" | "delete" | "bulkUpdate";
  intent?: string;
}) {
  const commands = useEntityCommands(entity ?? "product");

  const mutationOptions = mutationFn({
    onSuccess: (data: DataOf<TFn>) => {
      if (success !== undefined) {
        toast.success(
          typeof success === "function" ? success(data) : success,
          successToastId === undefined ? undefined : { id: successToastId },
        );
      }
      onSuccess?.(data);
    },
    onError: (err: unknown) => {
      toast.error(
        error === undefined
          ? getErrorMessage(err)
          : typeof error === "function"
            ? error(err)
            : error,
      );
    },
  } as never);

  const registeredOptions = entity
    ? {
        ...mutationOptions,
        mutationFn: async (variables: VariablesOf<TFn>) => {
          const input = variables as {
            id?: string;
            ids?: readonly string[];
            data?: object;
          };
          if (operation === "delete") {
            const result = await commands.remove(
              input.ids ?? (input.id ? [input.id] : []),
            );
            if (!result.ok) {
              throw new Error(result.issues[0]?.message ?? "Delete failed");
            }
            return result.result as DataOf<TFn>;
          }
          if (operation === "bulkUpdate") {
            const result = await commands.bulkUpdate(
              input.ids ?? (input.id ? [input.id] : []),
              input.data ?? {},
            );
            if (!result.ok) {
              throw new Error(
                result.issues[0]?.message ?? "Bulk update failed",
              );
            }
            return result.result as DataOf<TFn>;
          }
          if (operation === "update") {
            if (!input.id) throw new Error("Update requires an id.");
            const result = await commands.commitRuntimeFields({
              record: { id: input.id },
              values: input.data ?? {},
              intent,
              surface: "detail",
            });
            if (!result.ok) {
              throw new Error(result.issues[0]?.message ?? "Update failed");
            }
            return result.result as DataOf<TFn>;
          }
          const execution = await commands.submit({
            operation: "create",
            intent,
            data: variables as object,
          });
          return execution.result as DataOf<TFn>;
        },
      }
    : mutationOptions;

  return useMutation<DataOf<TFn>, Error, VariablesOf<TFn>>(
    registeredOptions as Parameters<
      typeof useMutation<DataOf<TFn>, Error, VariablesOf<TFn>>
    >[0],
  );
}
