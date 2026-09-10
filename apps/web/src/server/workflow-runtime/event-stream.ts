import type { WorkflowDefinition, WorkflowStep } from "./definition";
import {
  executeWorkflow,
  WorkflowCancelledError,
  type WorkflowExecutionOptions,
} from "./execute";

type ResourceInput<Input, Resource> = {
  readonly input: Input;
  readonly resource: Resource;
};

/** A read-only external event source owns its protocol; application event mapping and
 * resource lifetime remain inspectable graphs. Acquire must either return the
 * complete resource or compensate its own partial acquisition. */
type EventStreamDefinition<Context, Input, Resource, Event, Output> = {
  readonly name: string;
  readonly kind: "eventStream";
  readonly acquire: WorkflowDefinition<Context, Input, Resource>;
  readonly source: WorkflowDefinition<
    Context,
    ResourceInput<Input, Resource>,
    AsyncIterable<Event>
  >;
  readonly event: WorkflowDefinition<
    Context,
    ResourceInput<Input, Resource> & { readonly event: Event },
    readonly Output[]
  >;
  readonly complete: WorkflowDefinition<
    Context,
    ResourceInput<Input, Resource>,
    readonly Output[]
  >;
  readonly release: WorkflowDefinition<
    Context,
    ResourceInput<Input, Resource>,
    void
  >;
};

const validateReadOnlySteps = <Context, Input>(
  steps: readonly WorkflowStep<Context, Input>[],
): void => {
  for (const step of steps) {
    switch (step.type) {
      case "call":
        break;
      case "branch":
        validateReadOnlySteps(step.whenTrue.steps);
        validateReadOnlySteps(step.whenFalse.steps);
        break;
      case "parallel":
        for (const branch of Object.values(step.branches))
          validateReadOnlySteps(branch.steps);
        break;
      case "map":
        validateReadOnlySteps(step.workflow.steps);
        break;
      default:
        throw new Error(`Event source workflows cannot contain ${step.type}`);
    }
  }
};

export const defineEventStream = <Context, Input, Resource, Event, Output>(
  definition: Omit<
    EventStreamDefinition<Context, Input, Resource, Event, Output>,
    "kind"
  >,
): EventStreamDefinition<Context, Input, Resource, Event, Output> => {
  validateReadOnlySteps(definition.acquire.steps);
  validateReadOnlySteps(definition.source.steps);
  validateReadOnlySteps(definition.event.steps);
  validateReadOnlySteps(definition.complete.steps);
  validateReadOnlySteps(definition.release.steps);
  return { kind: "eventStream", ...definition };
};

export async function* executeEventStream<
  Context,
  Input,
  Resource,
  Event,
  Output,
>(
  definition: EventStreamDefinition<Context, Input, Resource, Event, Output>,
  options: WorkflowExecutionOptions<Context, Input>,
): AsyncGenerator<Output, void> {
  const checkCancelled = () => {
    if (options.signal?.aborted)
      throw new WorkflowCancelledError({
        committed: false,
        effectsPending: false,
      });
  };
  checkCancelled();
  // Cancellation after acquisition must still expose the resource to finally.
  const resource = await executeWorkflow(definition.acquire, {
    ...options,
    signal: new AbortController().signal,
  });
  const input = { input: options.input, resource };
  try {
    checkCancelled();
    const source = await executeWorkflow(definition.source, {
      ...options,
      input,
    });
    for await (const event of source) {
      checkCancelled();
      const outputs = await executeWorkflow(definition.event, {
        ...options,
        input: { ...input, event },
      });
      for (const output of outputs) {
        checkCancelled();
        yield output;
      }
    }
    checkCancelled();
    const outputs = await executeWorkflow(definition.complete, {
      ...options,
      input,
    });
    for (const output of outputs) {
      checkCancelled();
      yield output;
    }
  } finally {
    await executeWorkflow(definition.release, {
      ...options,
      input,
      signal: new AbortController().signal,
    });
  }
}

export function bindEventStream<
  Context,
  Input,
  Resource,
  Event,
  Output,
  Args extends readonly unknown[],
>(
  definition: EventStreamDefinition<Context, Input, Resource, Event, Output>,
  prepare: (...args: Args) => WorkflowExecutionOptions<Context, Input>,
) {
  return Object.assign(
    (...args: Args) => executeEventStream(definition, prepare(...args)),
    { definition },
  );
}
