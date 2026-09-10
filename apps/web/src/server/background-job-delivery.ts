import {
  executeWorkflow,
  type WorkflowDefinition,
  WorkflowCancelledError,
  WorkflowEffectError,
} from "~/server/workflow-runtime";
import { inspectWorkflow } from "~/server/workflow-runtime/definition";

/**
 * A durable job owns a narrower recovery rule than an ordinary workflow. Once
 * its lease is claimed, fail-or-retry may settle the same job after payload,
 * completion, or continuation writes: the repository operation is the
 * idempotent owner of that row's retry state. This must not be modelled as a
 * generic workflow attempt, whose write boundary deliberately prohibits it.
 */
export type BackgroundJobDeliveryDefinition<
  Context,
  PayloadInput,
  Status extends string,
  Outcome extends string,
> = {
  readonly name: string;
  readonly payload: WorkflowDefinition<Context, PayloadInput, Status>;
  readonly finish: WorkflowDefinition<
    Context,
    { readonly status: Status },
    void
  >;
  readonly advance: WorkflowDefinition<Context, undefined, void>;
  readonly failOrRetry: WorkflowDefinition<
    Context,
    { readonly error: unknown },
    Extract<Outcome, "retry" | "failed">
  >;
  readonly failedAdvance: WorkflowDefinition<Context, undefined, void>;
};

export const inspectBackgroundJobDelivery = <
  Context,
  PayloadInput,
  Status extends string,
  Outcome extends string,
>(
  definition: BackgroundJobDeliveryDefinition<
    Context,
    PayloadInput,
    Status,
    Outcome
  >,
) => ({
  name: definition.name,
  payload: inspectWorkflow(definition.payload),
  finish: inspectWorkflow(definition.finish),
  advance: inspectWorkflow(definition.advance),
  failOrRetry: inspectWorkflow(definition.failOrRetry),
  failedAdvance: inspectWorkflow(definition.failedAdvance),
});

export const executeBackgroundJobDelivery = async <
  Context,
  PayloadInput,
  Status extends string,
  Outcome extends string,
>(
  definition: BackgroundJobDeliveryDefinition<
    Context,
    PayloadInput,
    Status,
    Outcome
  >,
  options: {
    readonly context: Context;
    readonly payload: PayloadInput;
    readonly onError: <Failure>(error: Failure) => void;
  },
): Promise<Status | Extract<Outcome, "retry" | "failed">> => {
  try {
    const status = await executeWorkflow(definition.payload, {
      context: options.context,
      input: options.payload,
    });
    await executeWorkflow(definition.finish, {
      context: options.context,
      input: { status },
    });
    await executeWorkflow(definition.advance, {
      context: options.context,
      input: undefined,
    });
    return status;
  } catch (error) {
    // Cancellation cannot be settled as a delivery failure. A required effect
    // inside this durable boundary is different: its original cause must use
    // the job row's idempotent retry contract, just like pre-graph dispatch.
    if (error instanceof WorkflowCancelledError) throw error;
    const failure = error instanceof WorkflowEffectError ? error.cause : error;
    options.onError(failure);
    const outcome = await executeWorkflow(definition.failOrRetry, {
      context: options.context,
      input: { error: failure },
    });
    if (outcome === "failed")
      await executeWorkflow(definition.failedAdvance, {
        context: options.context,
        input: undefined,
      });
    return outcome;
  }
};
