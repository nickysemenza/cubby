import type { BulkProgressEvent } from "~/lib/bulk-progress";

import { executeBulkWorkflow, type BulkWorkflowDefinition } from "./bulk";
import type { WorkflowDefinition } from "./definition";
import { executeWorkflow, type WorkflowExecutionOptions } from "./execute";

/** A preparation graph can acquire a selection and derived metadata once,
 * then expose both explicitly to a normal bulk graph. This avoids fake items
 * for empty selections while keeping item and finalization inputs inspectable. */
export type PreparedBulkWorkflowDefinition<
  Context,
  Input,
  PreparedContext,
  PreparedInput,
  Item,
  Result,
  Event,
  Output,
> = {
  readonly name: string;
  readonly kind: "preparedBulk";
  readonly prepare: WorkflowDefinition<
    Context,
    Input,
    { readonly context: PreparedContext; readonly input: PreparedInput }
  >;
  readonly bulk: BulkWorkflowDefinition<
    PreparedContext,
    PreparedInput,
    Item,
    Result,
    Event,
    Output
  >;
};

export const definePreparedBulkWorkflow = <
  Context,
  Input,
  PreparedContext,
  PreparedInput,
  Item,
  Result,
  Event,
  Output,
>(
  definition: Omit<
    PreparedBulkWorkflowDefinition<
      Context,
      Input,
      PreparedContext,
      PreparedInput,
      Item,
      Result,
      Event,
      Output
    >,
    "kind"
  >,
): PreparedBulkWorkflowDefinition<
  Context,
  Input,
  PreparedContext,
  PreparedInput,
  Item,
  Result,
  Event,
  Output
> => {
  if (definition.name !== definition.bulk.name) {
    throw new Error("Prepared bulk workflow and bulk names must match");
  }
  return { kind: "preparedBulk", ...definition };
};

export async function* executePreparedBulkWorkflow<
  Context,
  Input,
  PreparedContext,
  PreparedInput,
  Item,
  Result,
  Event,
  Output,
>(
  definition: PreparedBulkWorkflowDefinition<
    Context,
    Input,
    PreparedContext,
    PreparedInput,
    Item,
    Result,
    Event,
    Output
  >,
  options: WorkflowExecutionOptions<Context, Input>,
): AsyncGenerator<BulkProgressEvent<Event, Output>, void> {
  const prepared = await executeWorkflow(definition.prepare, options);
  yield* executeBulkWorkflow(definition.bulk, {
    context: prepared.context,
    input: prepared.input,
    signal: options.signal,
    observer: options.observer,
  });
}

export function bindPreparedBulkWorkflow<
  Context,
  Input,
  PreparedContext,
  PreparedInput,
  Item,
  Result,
  Event,
  Output,
  Args extends readonly unknown[],
>(
  definition: PreparedBulkWorkflowDefinition<
    Context,
    Input,
    PreparedContext,
    PreparedInput,
    Item,
    Result,
    Event,
    Output
  >,
  prepare: (...args: Args) => WorkflowExecutionOptions<Context, Input>,
) {
  return Object.assign(
    (...args: Args) =>
      executePreparedBulkWorkflow(definition, prepare(...args)),
    { definition },
  );
}
