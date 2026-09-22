import type { BulkProgressEvent } from "~/lib/bulk-progress";
import type { UnparsedError } from "~/lib/error-utils";

import type { WorkflowDefinition } from "./definition";
import {
  executeWorkflow,
  WorkflowCancelledError,
  WorkflowEffectError,
  type WorkflowExecutionOptions,
} from "./execute";

export type BulkWorkflowSummary<Item, Result> = {
  readonly succeeded: readonly { index: number; item: Item; result: Result }[];
  readonly failed: readonly { index: number; item: Item; error: unknown }[];
};

export type BulkWorkflowDefinition<
  Context,
  Input,
  Item,
  Result,
  Event,
  Output,
> = {
  readonly name: string;
  readonly kind: "bulk";
  readonly items: WorkflowDefinition<Context, Input, readonly Item[]>;
  readonly item: WorkflowDefinition<Context, Item, Result>;
  readonly finalize: WorkflowDefinition<
    Context,
    BulkWorkflowSummary<Item, Result>,
    Output
  >;
  /** Starts one bounded window at a time; progress retains input order. */
  readonly concurrency?: number;
  /** Item streams report each settled item by default. A batch-shaped source
   * can expose only its completed windows without changing settlement. */
  readonly progressCadence?: "item" | "window";
  /** Most streams start with an empty progress tick. Sources whose first
   * observable event is a completed item can opt out. */
  readonly initialProgress?: boolean;
  readonly onItemError: "stop" | "continue";
  readonly errorProgress?: (error: UnparsedError, item: Item) => Event | void;
  readonly progress: (result: Result) => Event | void;
};

export function defineBulkWorkflow<Context, Input, Item, Result, Event, Output>(
  definition: Omit<
    BulkWorkflowDefinition<Context, Input, Item, Result, Event, Output>,
    "kind"
  >,
): BulkWorkflowDefinition<Context, Input, Item, Result, Event, Output> {
  if (
    definition.concurrency !== undefined &&
    (!Number.isInteger(definition.concurrency) || definition.concurrency < 1)
  ) {
    throw new Error("Bulk workflow concurrency must be a positive integer");
  }
  if (
    definition.progressCadence !== undefined &&
    definition.progressCadence !== "item" &&
    definition.progressCadence !== "window"
  ) {
    throw new Error("Bulk workflow progress cadence must be item or window");
  }
  return { kind: "bulk", ...definition };
}

type BulkItemOutcome<Item, Result> = { index: number; item: Item } & (
  | { status: "fulfilled"; result: Result }
  | { status: "rejected"; error: UnparsedError; itemCommitted: boolean }
);

function bulkItemProgress<Item, Result, Event>(
  progress: (result: Result) => Event | void,
  errorProgress:
    | ((error: UnparsedError, item: Item) => Event | void)
    | undefined,
  outcome: BulkItemOutcome<Item, Result>,
  total: number,
): BulkProgressEvent<Event, never> {
  const event =
    outcome.status === "fulfilled"
      ? progress(outcome.result)
      : errorProgress?.(outcome.error, outcome.item);
  return event === undefined
    ? { type: "progress", done: outcome.index + 1, total }
    : { type: "progress", done: outcome.index + 1, total, item: event };
}

function initialBulkProgress<Context, Input, Item, Result, Event, Output>(
  definition: BulkWorkflowDefinition<
    Context,
    Input,
    Item,
    Result,
    Event,
    Output
  >,
  total: number,
): readonly BulkProgressEvent<Event, never>[] {
  return definition.initialProgress === false
    ? []
    : [{ type: "progress", done: 0, total }];
}

async function runBulkWindow<Context, Input, Item, Result>(
  itemWorkflow: WorkflowDefinition<Context, Item, Result>,
  items: readonly Item[],
  start: number,
  options: WorkflowExecutionOptions<Context, Input>,
  observer: NonNullable<WorkflowExecutionOptions<Context, Input>["observer"]>,
) {
  return Promise.all(
    items.map(async (item, offset) => {
      const index = start + offset;
      let itemCommitted = false;
      try {
        const result = await executeWorkflow(itemWorkflow, {
          ...options,
          input: item,
          signal: new AbortController().signal,
          observer: (event) => {
            itemCommitted ||= event.committed;
            observer(event);
          },
        });
        return { status: "fulfilled" as const, index, item, result };
      } catch (error) {
        return {
          status: "rejected" as const,
          index,
          item,
          error,
          itemCommitted,
        };
      }
    }),
  );
}

/** Both matter: `stoppedBy` is why the run stopped, the finalizer failure is why
 * committed work is not settled. Returns the committed-effect error with the
 * stopping error carried on it so neither the caller nor Sentry loses either. */
function wrapFinalizationFailure(
  finalizationError: UnparsedError,
  finalizeName: string,
  stoppedBy: UnparsedError,
): WorkflowEffectError {
  return finalizationError instanceof WorkflowEffectError
    ? new WorkflowEffectError(
        finalizationError.effect,
        finalizationError.pendingEffects,
        finalizationError.cause,
        stoppedBy,
      )
    : new WorkflowEffectError(
        finalizeName,
        [finalizeName],
        finalizationError,
        stoppedBy,
      );
}

/** Pull-based streaming over the same executable graphs as ordinary operations.
 * Each item settles its required effects before yielding. Once writes commit,
 * finalization also runs on early close/cancellation, using the completed subset.
 * Cancellation waits for every started item in the current window to settle.
 * No later window is prefetched and no producer survives the consumer's return(). */
export async function* executeBulkWorkflow<
  Context,
  Input,
  Item,
  Result,
  Event,
  Output,
>(
  definition: BulkWorkflowDefinition<
    Context,
    Input,
    Item,
    Result,
    Event,
    Output
  >,
  options: WorkflowExecutionOptions<Context, Input>,
): AsyncGenerator<BulkProgressEvent<Event, Output>, void> {
  const signal = options.signal ?? new AbortController().signal;
  let committed = false;
  let finalized = false;
  let completed = false;
  let terminalNotified = false;
  const succeeded: { index: number; item: Item; result: Result }[] = [];
  const failed: { index: number; item: Item; error: unknown }[] = [];
  const observer: NonNullable<typeof options.observer> = (event) => {
    committed ||= event.committed;
    options.observer?.(event);
  };
  const notify = (
    state: "started" | "succeeded" | "cancelled" | "failed",
    error?: UnparsedError,
  ) => {
    try {
      options.observer?.({
        workflow: definition.name,
        step: definition.name,
        type: "workflow",
        state,
        committed,
        error,
      });
    } catch (error) {
      // SILENT: diagnostic subscribers cannot roll back a write or block the
      // bulk run's own effect handling; a broken observer must not fail it.
      console.error("Workflow observer failed", error);
    }
  };
  const checkCancelled = () => {
    if (signal.aborted)
      throw new WorkflowCancelledError({
        committed,
        effectsPending: !finalized && committed,
      });
  };
  const finish = async () => {
    // Mark before awaiting: a failed finalizer must never replay committed writes.
    finalized = true;
    try {
      return await executeWorkflow(definition.finalize, {
        ...options,
        observer,
        input: { succeeded, failed },
        signal: committed ? new AbortController().signal : signal,
      });
    } catch (error) {
      if (committed && !(error instanceof WorkflowEffectError))
        throw new WorkflowEffectError(
          definition.finalize.name,
          [definition.finalize.name],
          error,
        );
      throw error;
    }
  };
  const finishOnClose = async () => {
    try {
      await finish();
    } catch (error) {
      terminalNotified = true;
      notify("failed", error);
      throw error;
    }
  };
  notify("started");
  try {
    checkCancelled();
    const items = await executeWorkflow(definition.items, {
      ...options,
      observer,
      signal,
    });
    yield* initialBulkProgress(definition, items.length);
    const concurrency = definition.concurrency ?? 1;
    for (let start = 0; start < items.length; start += concurrency) {
      checkCancelled();
      const outcomes = await runBulkWindow(
        definition.item,
        items.slice(start, start + concurrency),
        start,
        options,
        observer,
      );
      // Record all started work before raising a failure or yielding: close and
      // cancellation must finalize the entire committed window, not only ticks sent.
      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") {
          succeeded.push({
            index: outcome.index,
            item: outcome.item,
            result: outcome.result,
          });
        } else {
          failed.push({
            index: outcome.index,
            item: outcome.item,
            error: outcome.error,
          });
        }
      }
      const fatal = outcomes.find(
        (outcome) =>
          outcome.status === "rejected" &&
          (outcome.error instanceof WorkflowCancelledError ||
            outcome.error instanceof WorkflowEffectError ||
            outcome.itemCommitted ||
            definition.onItemError === "stop"),
      );
      if (fatal?.status === "rejected") throw fatal.error;
      const progressOutcomes =
        definition.progressCadence === "window" ? [outcomes.at(-1)!] : outcomes;
      for (const outcome of progressOutcomes) {
        checkCancelled();
        yield bulkItemProgress(
          definition.progress,
          definition.errorProgress,
          outcome,
          items.length,
        );
      }
    }
    const result = await finish();
    checkCancelled();
    completed = true;
    terminalNotified = true;
    notify("succeeded");
    yield { type: "done", result };
  } catch (error) {
    let failure = error;
    if (!finalized && committed) {
      try {
        await finish();
      } catch (finalizationError) {
        failure = wrapFinalizationFailure(
          finalizationError,
          definition.finalize.name,
          error,
        );
      }
    }
    if (failure instanceof WorkflowCancelledError)
      failure = new WorkflowCancelledError({
        committed,
        effectsPending: false,
      });
    terminalNotified = true;
    notify(
      failure instanceof WorkflowCancelledError ? "cancelled" : "failed",
      failure,
    );
    throw failure;
  } finally {
    if (!finalized && committed) await finishOnClose();
    if (!completed && !terminalNotified) notify("cancelled");
  }
}

export function bindBulkWorkflow<
  Context,
  Input,
  Item,
  Result,
  Event,
  Output,
  Args extends readonly unknown[],
>(
  definition: BulkWorkflowDefinition<
    Context,
    Input,
    Item,
    Result,
    Event,
    Output
  >,
  prepare: (...args: Args) => WorkflowExecutionOptions<Context, Input>,
) {
  return Object.assign(
    (...args: Args) => executeBulkWorkflow(definition, prepare(...args)),
    { definition },
  );
}
