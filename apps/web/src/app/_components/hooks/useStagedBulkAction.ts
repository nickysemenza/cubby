import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import { verbBulkAction } from "../actions/action-verb-ui";
import type { ActionVerbId } from "../actions/action-verbs";
import type { BulkAction } from "../data-table/bulk-actions.types";
import {
  type DataOf,
  type MutationOptionsFn,
  useActionMutation,
  type VariablesOf,
} from "./useActionMutation";

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
  TFn extends MutationOptionsFn,
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
  submit: (
    values: Omit<VariablesOf<TFn>, "ids">,
  ) => Promise<DataOf<TFn> | undefined>;
}

export function useStagedBulkAction<
  TRow extends RowData & { id: string },
  TFn extends MutationOptionsFn,
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
  mutationFn: TFn;
  success?: ReactNode | ((data: DataOf<TFn>) => ReactNode);
}): StagedBulkAction<TRow, TFn> {
  const [items, setItems] = useState<TRow[]>([]);

  const mutation = useActionMutation({
    mutationFn,
    success,
    onSuccess: () => setItems([]),
  });

  const action = useMemo(
    () =>
      verbBulkAction<TRow>(verb, {
        ...(id ? { id } : {}),
        minSelection,
        onExecute: async (rows) => {
          setItems(rows.map((row) => row.original));
          return { success: true };
        },
      }),
    [verb, id, minSelection],
  );

  const cancel = useCallback(() => setItems([]), []);

  // `mutateAsync` is stable; `items` is not, so this closes over the staged
  // rows current at submit time rather than at action-creation time.
  const submit = useCallback(
    async (values: Omit<VariablesOf<TFn>, "ids">) =>
      (await mutation.mutateAsync({
        ...values,
        ids: items.map((item) => item.id),
      } as VariablesOf<TFn>)) as DataOf<TFn>,
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
    [mutation.mutateAsync, items],
  );

  return { items, action, isPending: mutation.isPending, cancel, submit };
}
