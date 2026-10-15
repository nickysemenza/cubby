import type { BulkProgressEvent } from "~/lib/bulk-progress";

import type { WorkflowDefinition } from "./definition";
import {
  executeWorkflow,
  WorkflowCancelledError,
  type WorkflowExecutionOptions,
} from "./execute";

/** A finite coordinator exposes the two durable phases shared by maintenance
 * streams: select the exact work set, then commit the selected batch.
 * It does not split a batch transaction into individual item writes. */
export type CoordinatorStreamDefinition<Context, Input, Selection, Result> = {
  readonly name: string;
  readonly kind: "coordinator";
  readonly select: WorkflowDefinition<Context, Input, Selection>;
  readonly commit: WorkflowDefinition<
    Context,
    { readonly input: Input; readonly selection: Selection },
    Result
  >;
  readonly total: (selection: Selection) => number;
  /** Override the completion tick when a durable batch reports a completed
   * subset (including an explicit zero-sized batch). */
  readonly completionProgress?: (
    selection: Selection,
    result: Result,
  ) => { readonly done: number; readonly total: number } | null;
};

export const defineCoordinatorStream = <Context, Input, Selection, Result>(
  definition: Omit<
    CoordinatorStreamDefinition<Context, Input, Selection, Result>,
    "kind"
  >,
): CoordinatorStreamDefinition<Context, Input, Selection, Result> => ({
  kind: "coordinator",
  ...definition,
});

const cancellationBeforeWork = () =>
  new WorkflowCancelledError({ committed: false, effectsPending: false });

/** Pull-based execution means a caller that closes after the selection tick
 * never starts the batch commit. Once the commit starts, its ordinary workflow
 * semantics settle required effects before any cancellation is reported. */
export async function* executeCoordinatorStream<
  Context,
  Input,
  Selection,
  Result,
>(
  definition: CoordinatorStreamDefinition<Context, Input, Selection, Result>,
  options: WorkflowExecutionOptions<Context, Input>,
): AsyncGenerator<BulkProgressEvent<never, Result>, void> {
  if (options.signal?.aborted) throw cancellationBeforeWork();
  const selection = await executeWorkflow(definition.select, options);
  const total = definition.total(selection);
  yield { type: "progress", done: 0, total };
  if (options.signal?.aborted) throw cancellationBeforeWork();
  const result = await executeWorkflow(definition.commit, {
    ...options,
    input: { input: options.input, selection },
  });
  const completionProgress = definition.completionProgress
    ? definition.completionProgress(selection, result)
    : total > 0
      ? { done: total, total }
      : null;
  if (completionProgress) yield { type: "progress", ...completionProgress };
  yield { type: "done", result };
}

/** Bind server-only arguments while retaining the concrete phase definitions
 * for operation inspection and tracing. */
export function bindCoordinatorStream<
  Context,
  Input,
  Selection,
  Result,
  Args extends readonly unknown[],
>(
  definition: CoordinatorStreamDefinition<Context, Input, Selection, Result>,
  prepare: (...args: Args) => WorkflowExecutionOptions<Context, Input>,
) {
  return Object.assign(
    (...args: Args) => executeCoordinatorStream(definition, prepare(...args)),
    { definition },
  );
}
