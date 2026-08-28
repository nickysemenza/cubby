import type { UseMutationOptions } from "@tanstack/react-query";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import { verbBulkAction } from "../actions/action-verb-ui";
import type { ActionVerbId } from "../actions/action-verbs";
import type { BulkAction } from "../data-table/bulk-actions.types";
import { useActionMutation } from "./useActionMutation";

/**
 * The stage → dialog → mutate → toast → clear cycle every bulk action runs.
 *
 * A bulk verb whose value needs collecting cannot write from `onExecute`: the
 * selection bar has nowhere to ask "which project?", so the action stages its
 * rows and a dialog does the write. That shape was hand-written seven times
 * across the task and expense bulk-action files — four state setters, four
 * near-identical `useActionMutation` blocks, four dialog wrappers that each
 * re-derive `ids` and re-clear the same state.
 *
 * What stays at the call site is the part that genuinely differs: which dialog
 * collects the value, and what that value is called in the payload.
 */
export interface StagedBulkAction<
  TRow extends RowData,
  TData,
  TValues extends object,
> {
  /** Rows awaiting the dialog. Empty means the dialog is closed. */
  items: TRow[];
  /** For the selection bar's `actions` array. */
  action: BulkAction<TRow>;
  isPending: boolean;
  /** Discard the staged rows — wire to the dialog's `onOpenChange(false)`. */
  cancel: () => void;
  /**
   * Write. `ids` is derived from the staged rows, so the caller passes only
   * the value its dialog collected. Rejects on failure, so a caller can
   * sequence its own "and then clear the selection" after it.
   */
  submit: (values: TValues) => Promise<TData | undefined>;
}

export function useStagedBulkAction<
  TRow extends RowData & { id: string },
  TData,
  TError extends Error,
  TValues extends object,
  TContext,
>({
  verb,
  id,
  minSelection = 1,
  mutationFn,
  success,
}: {
  verb: ActionVerbId;
  /** Override only where an existing bulk-action id is load-bearing. */
  id?: string;
  minSelection?: number;
  mutationFn: () => UseMutationOptions<
    TData,
    TError,
    TValues & { ids: string[] },
    TContext
  >;
  success?: ReactNode | ((data: TData) => ReactNode);
}): StagedBulkAction<TRow, TData, TValues> {
  const [items, setItems] = useState<TRow[]>([]);

  const mutation = useActionMutation({
    mutationFn,
    success,
    onSuccess: () => setItems([]),
  });

  const action = useMemo(() => {
    const options: Parameters<typeof verbBulkAction<TRow>>[1] = {
      minSelection,
      onExecute: async (rows) => {
        setItems(rows.map((row) => row.original));
        return { success: true };
      },
    };
    if (id !== undefined) options.id = id;
    return verbBulkAction<TRow>(verb, options);
  }, [verb, id, minSelection]);

  const cancel = useCallback(() => setItems([]), []);

  // `mutateAsync` is stable; `items` is not, so this closes over the staged
  // rows current at submit time rather than at action-creation time.
  const submit = useCallback(
    async (values: TValues) => {
      const payload = {
        ...values,
        ids: items.map((item) => item.id),
      };
      return await mutation.mutateAsync(payload);
    },
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
    [mutation.mutateAsync, items],
  );

  return { items, action, isPending: mutation.isPending, cancel, submit };
}
